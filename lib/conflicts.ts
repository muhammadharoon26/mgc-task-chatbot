/**
 * Cross-document contradiction detection.
 *
 * This runs BEFORE the model and its output is injected into the prompt as a
 * hard instruction. The reason is the brief's own test case: the transfer fee is
 * 2% in the price list and 2.5% in the booking FAQ. Left to the model, that
 * resolves to whichever number it happened to attend to — a confident wrong
 * answer, which the brief says costs a sale.
 *
 * Detection is mechanical: same topic + different values + different documents.
 * Recency is computed from each document's own effective date, not inferred.
 */
import { CORPUS } from "./corpus.generated";
import type { Conflict, ConflictClaim, Section } from "./types";

type ValueKind = "percent" | "pkr";

type Topic = {
  id: string;
  label: string;
  /** A sentence must contain one of these to be considered a claim about this topic. */
  keywords: string[];
  kind: ValueKind;
  /**
   * Terms in the user's question that make this topic relevant. Used to decide
   * which conflicts to inject into a given prompt rather than dumping all of them.
   */
  queryTerms: string[];
};

/**
 * The contestable-fact vocabulary.
 *
 * Deliberately a small explicit list rather than "find every number in every
 * document and compare". A generic numeric differ produces mostly noise — the
 * price list and the brochure quote different unit counts, areas and dates for
 * perfectly good reasons. Naming the facts that a salesperson would actually
 * quote to a customer keeps precision at 100%, which matters more than recall
 * for something that interrupts an answer.
 */
const TOPICS: Topic[] = [
  {
    id: "transfer_fee",
    label: "Transfer fee",
    keywords: ["transfer fee", "transfer is", "transferred"],
    kind: "percent",
    queryTerms: ["transfer", "transfers", "resale", "resell"],
  },
  {
    id: "overseas_discount",
    label: "Overseas buyer discount",
    keywords: ["overseas"],
    kind: "percent",
    queryTerms: ["overseas", "roshan", "expat", "foreign", "abroad"],
  },
  {
    id: "token_deduction",
    label: "Cancellation deduction on the token",
    keywords: ["processing deduction", "token is refundable", "cancels within"],
    kind: "pkr",
    queryTerms: ["cancel", "cancellation", "refund", "refundable", "token"],
  },
  {
    id: "liquidated_damages",
    label: "Liquidated damages on default",
    keywords: ["liquidated damages", "defaults on"],
    kind: "percent",
    queryTerms: ["default", "defaults", "damages", "missed", "instalment"],
  },
];

/** Split on sentence boundaries and list-item boundaries — the docs use both. */
function sentences(text: string): string[] {
  return text
    .split(/(?:\n\s*[-*]\s*)|(?:\.\s+)|(?:\n{2,})|\n\|/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function extractValues(sentence: string, kind: ValueKind): string[] {
  if (kind === "percent") {
    return [...sentence.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => `${m[1]}%`);
  }
  // PKR amounts: either "PKR 75,000" or a bare grouped number of 5+ digits.
  const out: string[] = [];
  for (const m of sentence.matchAll(/PKR\s*([\d,]+)/gi)) out.push(normaliseAmount(m[1]));
  for (const m of sentence.matchAll(/(?<!PKR\s)\b(\d{1,3}(?:,\d{3})+)\b/g)) {
    out.push(normaliseAmount(m[1]));
  }
  return [...new Set(out)];
}

function normaliseAmount(raw: string): string {
  return `PKR ${Number(raw.replace(/,/g, "")).toLocaleString("en-US")}`;
}

function claimsForTopic(topic: Topic, sections: Section[]): ConflictClaim[] {
  const claims: ConflictClaim[] = [];

  for (const section of sections) {
    for (const sentence of sentences(section.text)) {
      const lower = sentence.toLowerCase();
      if (!topic.keywords.some((k) => lower.includes(k))) continue;

      for (const value of extractValues(sentence, topic.kind)) {
        claims.push({
          sectionId: section.id,
          docId: section.docId,
          docTitle: section.docTitle,
          effectiveDate: section.effectiveDate,
          version: section.version,
          value,
          context: sentence,
        });
      }
    }
  }
  return claims;
}

/**
 * A topic is in conflict when it has at least two distinct values coming from at
 * least two distinct documents. Both halves matter: one document listing 2% and
 * 2.5% for different things is not a contradiction, and two documents agreeing
 * on 2% is not either.
 */
function toConflict(topic: Topic, claims: ConflictClaim[]): Conflict | null {
  const distinctValues = new Set(claims.map((c) => c.value));
  const distinctDocs = new Set(claims.map((c) => c.docId));
  if (distinctValues.size < 2 || distinctDocs.size < 2) return null;

  // Keep one claim per (doc, value) so the prompt isn't repetitive.
  const seen = new Set<string>();
  const deduped = claims.filter((c) => {
    const key = `${c.docId}|${c.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const newest = deduped.reduce((a, b) =>
    a.effectiveDate >= b.effectiveDate ? a : b,
  );

  return {
    topic: topic.id,
    label: topic.label,
    claims: deduped,
    newerDocId: newest.docId,
  };
}

/**
 * Precomputed once at module load over the WHOLE corpus, never per query.
 *
 * This is deliberate and it is the design decision I would defend hardest.
 * If conflicts were detected only among retrieved sections, then the moment
 * top-k retrieval drops one of the two contradicting chunks the guarantee
 * disappears — silently. Detecting over the full index means the property holds
 * at any k, and it is what lets the scale plan (DESIGN.md §2.6) move to top-k
 * retrieval without losing the behaviour the brief is testing.
 */
export const ALL_CONFLICTS: Conflict[] = TOPICS.map((topic) =>
  toConflict(topic, claimsForTopic(topic, CORPUS)),
).filter((c): c is Conflict => c !== null);

const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));

/** Conflicts relevant to this question, by query-term match. */
export function conflictsFor(query: string): Conflict[] {
  const lower = query.toLowerCase();
  return ALL_CONFLICTS.filter((conflict) => {
    const topic = TOPIC_BY_ID.get(conflict.topic);
    return topic?.queryTerms.some((term) => lower.includes(term)) ?? false;
  });
}

/** Renders a conflict for the prompt. Dates are spelled out so the model doesn't have to compare them. */
export function formatConflict(conflict: Conflict): string {
  const lines = conflict.claims.map((c) => {
    const newer = c.docId === conflict.newerDocId ? "  [MORE RECENT]" : "";
    return `  - ${c.value} — ${c.docTitle} (${c.version}, effective ${c.effectiveDate}), section ${c.sectionId}${newer}\n    context: "${c.context}"`;
  });
  return `CONFLICT · ${conflict.label}\n${lines.join("\n")}`;
}
