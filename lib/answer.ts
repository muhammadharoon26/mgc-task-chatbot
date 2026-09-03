/**
 * The answering pipeline: context assembly → one Gemini call → verification.
 *
 * Read DESIGN.md §3 alongside this. The short version: everything that is hard
 * to get right (which sections are relevant, whether two documents contradict,
 * what a unit costs) is computed deterministically before the model runs. The
 * model's job is to write prose over facts it has been handed, under a contract
 * that is then checked.
 */

import { z } from "zod";
import { SECTION_BY_ID } from "./corpus.generated";
import { conflictsFor, formatConflict } from "./conflicts";
import { canQuote, formatQuote, parseSlots, quote, type Slots } from "./pricing";
import { getRetriever } from "./retrieval";
import { callWithRotation, isConfigured } from "./gemini/keyPool";
import { answerOffline } from "./offline";
import type {
  Answer,
  AnswerStatus,
  ChatTurn,
  RankedSection,
} from "./types";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

/**
 * Messages of prior conversation replayed into the prompt, counting user and
 * assistant turns separately (so 16 is 8 exchanges).
 *
 * Exported because /api/chat trims the incoming history to the same number.
 * Two different caps in two files is how you end up sending 16 and using 8.
 */
export const MAX_HISTORY_MESSAGES = 16;

/** Below this normalised retrieval score we tell the model the retrieval was weak. */
const WEAK_RETRIEVAL_THRESHOLD = 0.15;

const SYSTEM_INSTRUCTION = `You are the MGC Developments sales copilot. You answer questions from MGC's own sales staff about the Aurora Heights project, using ONLY the document sections supplied to you in each request.

GROUNDING CONTRACT — these are absolute:
1. Every factual claim you make must come from a supplied section, and must be supported by a citation naming that section's id and a verbatim quote from it.
2. Never infer, estimate, average, or extrapolate a number. If a figure is not written in a section, you do not have it.
3. NEVER perform arithmetic. If a COMPUTED block is supplied, its totals are authoritative and already correct — present them, do not recalculate or "check" them. If no COMPUTED block is supplied, do not attempt to derive a price yourself.
4. If a CONFLICT block is supplied, you MUST present every value it lists, each with its document and effective date, and state which document is more recent. Do not choose one and present it as the answer. Recommend confirming with the marketing manager before quoting the customer.
5. MGC policy, which overrides helpfulness: never quote or estimate rental yields or rental-return projections, and never quote bank mark-up or interest rates. If asked, refuse and direct the enquiry to the marketing manager.

CHOOSING A STATUS — pick exactly one:
- "answered": the sections support a clear answer.
- "conflict": a CONFLICT block was supplied and is relevant to the question.
- "unconfirmed": the documents address the topic but explicitly state it is not yet decided, confirmed, or scheduled. Say what the documents actually say.
- "policy_refusal": the documents explicitly forbid sales staff from answering this. Cite the section that says so.
- "not_in_documents": the topic simply does not appear. Do not speculate.

A confident wrong answer costs MGC a sale. "I don't have that — please ask the marketing manager" costs nothing. When in doubt, refuse.

STYLE: address a colleague on the sales floor. Lead with the answer. Use PKR figures with thousands separators exactly as supplied. Be brief — three or four sentences unless presenting a price breakdown.`;

/**
 * Gemini's responseSchema accepts an OpenAPI subset, not full JSON Schema.
 * Written by hand rather than generated from the Zod type: it is 30 lines, and a
 * converter would need its unsupported keywords stripped anyway.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "answered",
        "conflict",
        "unconfirmed",
        "policy_refusal",
        "not_in_documents",
      ],
    },
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sectionId: { type: "string" },
          quote: { type: "string" },
        },
        required: ["sectionId", "quote"],
      },
    },
    caveats: { type: "array", items: { type: "string" } },
    escalateTo: { type: "string" },
  },
  required: ["status", "answer", "citations", "caveats"],
} as const;

/**
 * Second line of defence. A schema-constrained decode is not a guarantee — the
 * transport can still hand back something unexpected — and parsing must never
 * throw a 500 at a salesperson.
 */
const ModelAnswerSchema = z.object({
  status: z.enum([
    "answered",
    "conflict",
    "unconfirmed",
    "policy_refusal",
    "not_in_documents",
  ]),
  answer: z.string().min(1),
  citations: z
    .array(z.object({ sectionId: z.string(), quote: z.string() }))
    .default([]),
  caveats: z.array(z.string()).default([]),
  escalateTo: z.string().nullish(),
});

/**
 * Follow-up resolution (DESIGN.md §3.3).
 *
 * "And in Block A?" is meaningless to a retriever on its own. Concatenating the
 * previous user message with the current one is enough on a fixed-vocabulary
 * domain, costs nothing and adds no latency — and slot merging below is what
 * actually carries "2-bed" forward while letting "Block A" override.
 */
function standaloneQuery(message: string, history: ChatTurn[]): string {
  const lastUser = [...history].reverse().find((t) => t.role === "user");
  return lastUser ? `${lastUser.content} ${message}` : message;
}

/** Later slots win, so the new message overrides what it mentions and inherits the rest. */
function mergeSlots(previous: Slots, current: Slots): Slots {
  return { ...previous, ...current };
}

function renderSection(s: RankedSection): string {
  const focus = s.isFocus ? " [FOCUS]" : "";
  return `<section id="${s.id}" document="${s.docTitle}" version="${s.version}" effective="${s.effectiveDate}" heading="${s.heading}"${focus}>
${s.text}
</section>`;
}

export type AskResult = Answer & {
  /** Diagnostics surfaced to the UI so the pipeline's behaviour is never a guess. */
  meta: {
    strategy: string;
    topScore: number;
    conflictsDetected: string[];
    priceComputed: boolean;
    keyLabel: string | null;
    /** Keys tried before one succeeded. 1 means no rotation was needed. */
    keyAttempts: number;
    model: string;
    offline: boolean;
  };
};

export async function ask(
  message: string,
  history: ChatTurn[] = [],
): Promise<AskResult> {
  const query = standaloneQuery(message, history);

  // ── Deterministic stages ────────────────────────────────────────────────
  const retriever = getRetriever();
  const retrieval = await retriever.retrieve(query, { k: Infinity });

  const conflicts = conflictsFor(query);

  const priorSlots = history
    .filter((t) => t.role === "user")
    .reduce<Slots>((acc, t) => mergeSlots(acc, parseSlots(t.content)), {});
  const slots = mergeSlots(priorSlots, parseSlots(message));
  const priceQuote = canQuote(slots) ? quote(slots) : null;

  // ── No keys? Answer deterministically rather than failing (DESIGN.md §3.9) ──
  if (!isConfigured()) {
    const offline = answerOffline(message, retrieval.sections, conflicts, priceQuote);
    return {
      ...offline,
      meta: {
        strategy: retrieval.strategy,
        topScore: retrieval.topScore,
        conflictsDetected: conflicts.map((c) => c.topic),
        priceComputed: Boolean(priceQuote),
        keyLabel: null,
        keyAttempts: 0,
        model: "offline",
        offline: true,
      },
    };
  }

  // ── Prompt assembly ─────────────────────────────────────────────────────
  const parts: string[] = [];

  parts.push("DOCUMENT SECTIONS (the only permitted source of facts):");
  parts.push(retrieval.sections.map(renderSection).join("\n\n"));

  if (conflicts.length > 0) {
    parts.push(
      "\nCONFLICTS DETECTED — the documents disagree. Follow contract rule 4.",
    );
    parts.push(conflicts.map(formatConflict).join("\n\n"));
  }

  if (priceQuote) {
    parts.push("\n" + formatQuote(priceQuote));
  }

  if (retrieval.topScore < WEAK_RETRIEVAL_THRESHOLD) {
    parts.push(
      "\nRETRIEVAL NOTE: no section scored well against this question. Treat that as evidence the topic may not be covered, and prefer refusing over stretching a loosely related section.",
    );
  }

  if (history.length > 0) {
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    parts.push(
      "\nCONVERSATION SO FAR (for resolving references like \"it\" or \"that one\"):",
    );
    parts.push(
      recent
        .map((t) => `${t.role === "user" ? "Salesperson" : "You"}: ${t.content}`)
        .join("\n"),
    );
  }

  parts.push(`\nSALESPERSON'S QUESTION: ${message}`);

  /**
   * History is replayed as text inside a single user turn rather than as prior
   * API steps. Two reasons: the corpus is re-sent every turn anyway so there is
   * no state to preserve, and keeping the request a pure function of its input
   * means any key in the pool can serve any turn (DESIGN.md §3.2).
   */
  const prompt = parts.join("\n");

  const outcome = await callWithRotation(async (client) =>
    // The input array is written inline rather than hoisted into a variable so
    // that the SDK's parameter type narrows the `type` literals for us. Hoisted,
    // TypeScript widens "user_input" to string and the discriminated union stops
    // matching. The SDK declares those step types but does not export them, so
    // contextual typing is the way to stay type-checked here without an `any`.
    client.interactions.create({
      model: MODEL,
      store: false,
      input: [
        { type: "user_input", content: [{ type: "text", text: prompt }] },
      ],
      system_instruction: SYSTEM_INSTRUCTION,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: RESPONSE_SCHEMA,
      },
    }),
  );

  const raw = outcome.value.output_text ?? "";
  const answer = parseAndVerify(raw, retrieval.sections, conflicts.length > 0);

  return {
    ...answer,
    meta: {
      strategy: retrieval.strategy,
      topScore: retrieval.topScore,
      conflictsDetected: conflicts.map((c) => c.topic),
      priceComputed: Boolean(priceQuote),
      keyLabel: outcome.keyLabel,
      keyAttempts: outcome.attempts,
      model: MODEL,
      offline: false,
    },
  };
}

/** Whitespace-insensitive containment, so quoting across a line break still verifies. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[\s*_|]+/g, " ").trim();
}

/**
 * Verification (DESIGN.md §3.8). This is what turns "the prompt says don't
 * hallucinate" into "a hallucinated source is caught and downgraded".
 */
export function parseAndVerify(
  raw: string,
  sections: RankedSection[],
  conflictWasSupplied: boolean,
): Answer {
  let parsed: z.infer<typeof ModelAnswerSchema>;
  try {
    parsed = ModelAnswerSchema.parse(JSON.parse(raw));
  } catch {
    // Never surface a parse failure as a 500 — surface it as a refusal, which is
    // the safe direction for this product.
    return {
      status: "not_in_documents",
      answer:
        "I couldn't produce a verified answer for that. Please ask the marketing manager rather than relying on a guess.",
      citations: [],
      caveats: ["The assistant's response could not be validated."],
      escalateTo: "marketing manager",
    };
  }

  const verified = parsed.citations.flatMap((c) => {
    const section = SECTION_BY_ID.get(c.sectionId);
    // An id that isn't in the corpus means the model invented a source.
    if (!section) return [];
    // A quote that isn't in that section means it invented the support.
    if (!normalise(section.text).includes(normalise(c.quote))) return [];
    return [
      {
        sectionId: c.sectionId,
        documentTitle: section.docTitle,
        heading: section.heading,
        quote: c.quote,
      },
    ];
  });

  let status: AnswerStatus = parsed.status;
  const caveats = [...parsed.caveats];

  // The deterministic layer wins: if we handed the model a conflict, the answer
  // is a conflict, whatever it decided to call it.
  if (conflictWasSupplied && status === "answered") {
    status = "conflict";
  }

  // An "answered" with no surviving citation is an unsupported claim.
  if (status === "answered" && verified.length === 0) {
    return {
      status: "not_in_documents",
      answer:
        "I couldn't ground that in the MGC documents I have. Please check with the marketing manager.",
      citations: [],
      caveats: [
        ...caveats,
        "The draft answer could not be traced back to a source section, so it was withheld.",
      ],
      escalateTo: "marketing manager",
    };
  }

  if (verified.length < parsed.citations.length) {
    caveats.push(
      `${parsed.citations.length - verified.length} citation(s) could not be verified against the source documents and were removed.`,
    );
  }

  return {
    status,
    answer: parsed.answer,
    citations: verified,
    caveats,
    escalateTo: parsed.escalateTo ?? null,
  };
}
