# MGC Sales Copilot — Technical Design

**Author:** Muhammad Haroon
**Target:** MGC Developments · AI Developer & Engineer build task
**Deadline:** Thu 3 Sep 2026, 12:00 PM PKT
**Stack:** Next.js (App Router, TypeScript) · Google Gemini API with a multi-key rotation pool · deployed on Vercel

This document is the plan I build from, and the crib sheet for the 30-minute call.
Every decision below has a one-line "why", because the brief says the real test is
whether I can explain each line.

---

## 0. What the grader actually checks

| Criterion | Where this design earns it |
|---|---|
| **Does it run** from the README, on their machine | `npm install && npm run dev`. No Python at runtime, no vector DB, no Docker. Degrades gracefully with zero API keys (§3.9). |
| **Part 1's hard cases** — grounding, refusal, conflict | Deterministic conflict registry (§3.5) + typed refusal states (§3.7) + post-hoc citation validation (§3.8). Not "hoping the model behaves". |
| **Part 2's schema sense** — keys, types, dupes | Real types + ENUMs + CHECK constraints derived from the data (§5). Duplicate prevention is a `UNIQUE` index on the CRM fingerprint; detection runs against a staging table. |
| **Part 3's decisions** — what got dropped, honest number | One column is a hard target leak; five more are only available *after* the call. Both facts are measured, written down, and cost me accuracy on purpose (§6). |
| **Part 4 working at all** | A real chat interface, two API routes, no build step beyond Next (§7). |
| **Code you can explain** | No LLM framework. See §2 — that is the whole reason LangChain and LangGraph are out. |

Explicitly *not* graded, so deliberately time-boxed: visual polish, tests, auth,
CI. Vercel deploy is nearly free because the stack is already Next.js.

---

## 1. What I'm building

Not a Q&A form — a **sales copilot**: a chat interface a salesperson keeps open
next to the CRM, asks in plain language, and gets an answer that either cites the
document it came from or refuses cleanly and tells them who to ask.

Product requirements that follow from "professional chatbot" rather than "script":

- **Multi-turn.** "What's the base price of a 2-bed in Block B?" → "And in Block A?"
  must work. Follow-up resolution is a real design problem (§3.3).
- **Every answer is attributable.** Source card under each answer: document,
  section, verbatim quote. No citation → no answer.
- **Refusal is a first-class UI state**, visually distinct, never mistakeable for
  an answer at a glance.
- **It stays up.** Free-tier Gemini quotas will not survive a grading session on
  one key, so the key pool (§4) is a product requirement, not a flourish.
- **Session persistence** in `localStorage`, so a refresh doesn't lose the thread.

The second surface — lead scoring — lives on the same page as a side panel (§7).

---

## 2. Stack decision

### 2.1 The measurement that settles the architecture

```
docs/01_mgc_aurora_heights_brochure.md    2,266 bytes
docs/02_price_list_payment_plan.md        2,322 bytes
docs/03_booking_policy_faq.md             2,594 bytes
                                          ─────────────
                                          7,182 bytes  ≈ 2,000 tokens
```

**The entire knowledge base is ~2,000 tokens.** Gemini's Flash and Pro models
carry context windows in the hundreds of thousands to a million tokens. The
corpus fits hundreds of times over.

**This system is a RAG system.** Retrieve the relevant context → augment the
prompt → generate a grounded, cited answer. That is the pattern, and every stage
of it is here. What the size measurement changes is *one implementation detail
inside the retrieval stage*: the scorer, and the value of `k`.

It is worth being precise, because "RAG" and "vector database" get used
interchangeably and they are not the same thing:

| RAG stage | This system, today |
|---|---|
| Ingest & chunk | Markdown → ~20 heading-scoped sections with document metadata (§3.1) |
| Index | In-memory, built at compile time |
| Retrieve | Lexical BM25-style scoring + synonym expansion (§2.2) |
| Rank & select | Score-ordered; `k = all` at this corpus size, with a documented switch |
| Augment | Sections + conflict blocks + computed facts injected into the prompt (§3.6) |
| Generate | Gemini, under a grounding contract, structured output (§3.7) |
| Verify | Citations resolved against the index; unverifiable → downgrade to refusal (§3.8) |

The last row is the part most RAG tutorials skip and the part this brief is
actually testing.

What the 2,000-token measurement *does* rule out is aggressive top-k selection
**at this size** — and the brief's own test questions show why:

- *"What's the transfer fee?"* — answered in **two documents that disagree**
  (price list: 2%, booking FAQ: 2.5%). Top-k chunk retrieval returns whichever
  chunk scores marginally higher; the model answers with one number, confidently,
  and never learns the other exists. That is exactly the "confident wrong answer
  costs us a sale" failure the brief warns about — and naive RAG *causes* it.
- *"Total for a Margalla-facing corner unit, floor 15, 2-bed Block B?"* — needs
  the Block B base-price table, the location-premiums list, and the brochure's
  "all units above floor 12 in Block B face the Margalla range". Three sections,
  two documents. A `k=3` retriever is one bad embedding away from dropping the
  premiums table and quoting the base price.

Aggressive chunk selection at this corpus size buys nothing and actively breaks
two of the five graded questions. So `k` is set to "all" **for now** — a
configured value, not a missing feature (§2.6).

### 2.2 I still build retrieval — for a different job

Not skipping it and hand-waving "stuff it all in". `retrieve()` is a real stage
doing three jobs that have nothing to do with context compression:

1. **Citations.** The brief requires the source shown. Scoring sections against
   the query decides *which* section to cite and in what order.
2. **Conflict detection.** Once sections are scored and tagged with their source
   document, I can mechanically notice two documents answering the same question
   with different numbers (§3.5).
3. **A strategy seam.** Retrieval sits behind an interface with **two shipped
   implementations**, chosen by env var — not a promise to refactor later (§2.6).

What retrieval does **not** do here is discard. **Recall is pinned at 1.0** —
every section enters the prompt, ordered by score, top matches flagged as focus.
Cost: ~2,000 extra input tokens per turn, which on Flash is rounding-error money.
Benefit: the conflict is structurally impossible to miss.

> The call answer I'm aiming for: *"I built retrieval, measured the corpus, then
> configured it not to discard anything — at 2k tokens its only honest job is
> ranking citations. Here's the line that changes when the corpus grows."*

### 2.3 LangChain — not in the request path, and here is where it *would* earn its place

The honest version of this verdict has two halves.

**Where LangChain genuinely wins, and I'd use it:** document *ingestion* at scale.
MGC's real documents are PDFs — the brief says staff "flip through PDFs" today.
When this system ingests 200 real PDFs plus DOCX plus scraped HTML,
`PyPDFLoader` / `UnstructuredLoader` and `RecursiveCharacterTextSplitter` are
hundreds of edge cases (multi-column layouts, tables, headers, OCR fallback) that
I would be foolish to reimplement. Vector-store adapters are real value too —
swapping pgvector for Pinecone becomes a one-line change.

**Why it still isn't in this build:** ingestion is **offline, build-time work**,
not request-path work. That distinction is the whole answer. The scale plan
(§2.6) puts loaders and splitters in `scripts/ingest.ts`, which runs on my
machine and commits an index — it never ships to Vercel, never enters the
serverless bundle, never sits between a salesperson and an answer.

In the request path, the arguments against stand:

| Argument for | Verdict |
|---|---|
| Retrievers, `RetrievalQA`, chains | ~150 lines of my own, and I'd read the source anyway to know what the abstraction does |
| The brief's hard rule: *"you must be able to explain every line you submit"* | Decisive at this deadline. "Why is there a `RunnableSequence` here" has no good answer except "the tutorial had one" |
| Bundle size on Vercel | Large transitive tree inside a serverless function for a handful of helper calls |
| Abstracts over provider differences | I have one provider — and my provider layer is a **key pool** (§4). I need per-request control over *which client instance* serves a call plus error-code introspection to classify 429 vs 403 vs 5xx. Through a framework's client wrapper that means fighting it |
| Conflict detection, PKR arithmetic, refusal states, citation verification | None of it exists in LangChain. All the difficulty that makes this task hard is domain logic I write either way |

That last row is the one I'd defend hardest. Everything the brief actually grades
— the conflict, the refusals, the grounded arithmetic — is code no framework
ships.

### 2.4 LangGraph — the right tool for the loop I haven't earned yet

LangGraph is for **stateful, cyclic, multi-actor** graphs: reflection loops,
supervisor→worker routing, human-in-the-loop interrupts, checkpointed state.

Today's flow, drawn honestly:

```
message + history
   ↓
[deterministic] resolve follow-up → standalone query
   ↓
[deterministic] retrieve + rank sections
   ↓
[deterministic] detect cross-document conflicts
   ↓
[deterministic] price intent? → compute exact quote + arithmetic trace
   ↓
[one Gemini call, via the key pool] answer under a grounding contract, structured output
   ↓
[deterministic] validate every citation resolves → downgrade to refusal if not
   ↓
answer
```

A **straight line**. Expressing six sequential calls as a `StateGraph` means node
registrations, an annotated state schema and edge declarations to say what
`const b = g(f(a))` already says.

**But the scaled version is genuinely cyclic, and I want to be specific about
which cycles appear**, because this is the strongest argument for LangGraph and
it deserves a straight answer rather than a brush-off:

1. **Corrective retrieval (CRAG).** At 200 documents, the top-scoring chunks are
   sometimes all irrelevant. The fix is a confidence gate: if the best score is
   below threshold, **rewrite the query and retrieve again** — a loop.
2. **Self-correction on failed grounding.** My validator (§3.8) already catches
   invented citations. Today it downgrades to a refusal. At scale the better move
   is to **feed the failure back and re-ask once** — a loop.
3. **Collection routing.** Multiple projects, each with its own price list and
   policy set, means classifying which corpus to search before searching it —
   branching, and plausibly a sub-agent per collection.

So: **the loops are real, and they arrive with scale.** My position is not "graphs
are unnecessary", it is *"I have not earned one yet, and I've designed so that
earning one isn't a rewrite."* Concretely, the pipeline is written as named pure
stages over a single `PipelineState` object — which is precisely the shape
LangGraph nodes take, so porting is mechanical rather than structural.

One deployment note that will matter when we do: LangGraph's checkpointer assumes
a long-lived process. Vercel functions are stateless per invocation, so adopting
it means either an external checkpointer (Postgres/Redis) or moving the agent to a
dedicated service. That's a real cost to budget, not a reason to avoid it.

**What I build instead, today:** a minimal version of loop #1 in ~30 lines — a
retrieval confidence gate that reformulates once and re-retrieves before giving
up. That is Corrective RAG, implemented, in the request path, with no framework.
The concept is what's being graded; the framework is an implementation choice.

### 2.4 LangGraph — no, and precisely why

LangGraph is for **stateful, cyclic, multi-actor** graphs: supervisor→worker
routing, reflection loops, human-in-the-loop interrupts, checkpointed
long-running state.

My flow, drawn honestly:

```
message + history
   ↓
[deterministic] resolve follow-up → standalone query
   ↓
[deterministic] retrieve + rank sections
   ↓
[deterministic] detect cross-document conflicts
   ↓
[deterministic] price intent? → compute exact quote + arithmetic trace
   ↓
[one Gemini call, via the key pool] answer under a grounding contract, structured output
   ↓
[deterministic] validate every citation resolves → downgrade to refusal if not
   ↓
answer
```

A **straight line**. No cycles, no branching that isn't a plain `if`, no second
actor. Expressing six sequential function calls as a `StateGraph` means node
registrations, an annotated state schema and edge declarations to say what
`const b = g(f(a))` already says — then defending that ceremony to a grader
explicitly looking for the simplest thing that works.

Deployment argument too: LangGraph's checkpointer assumes a long-lived process.
Vercel functions are stateless per invocation, so a graph needing no state would
still need Postgres or Redis wired in to satisfy the framework.

**When I would reach for it:** a copilot that loops retrieve→critique→re-retrieve
until confident, spawns a pricing sub-agent, and pauses for human approval at a
policy boundary. Genuinely cyclic and stateful. Today's task is not that, and I'd
rather ship the straight line and name the upgrade path.

### 2.5 The stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js 15, App Router, TypeScript** | Vercel's native target; one project serves UI + both API routes; zero deploy config |
| LLM | **`@google/genai` ≥ 2.3.0 → `ai.interactions.create()`** | Official Google SDK, called directly. Structured output via `response_format`, and a plain per-key client that the pool can own |
| Model | **`gemini-3.5-flash`** default, `GEMINI_MODEL` env-swappable | Flash keeps chat latency conversational. Model IDs move fast, so it is one env var, never a literal in code |
| Resilience | **Multi-key rotation pool** (§4) | The named requirement, and the thing that keeps a free-tier demo alive during grading |
| Retrieval | **`Retriever` interface, two implementations** — `lexical` (default) and `hybrid` (Gemini embeddings + BM25, fused by RRF) | §2.6. The scale path is a code path you can switch on, not a paragraph in a README |
| Vector index | **Build-time JSON** now; `VectorStore` interface with a pgvector implementation documented | Holds to ~5,000 chunks in memory with no service to run; §2.6 has the threshold where that stops being true |
| ML training | **Python + scikit-learn**, offline, one script | The expected tool; committed with its metrics output |
| ML serving | **`model.json` + ~40 lines of TypeScript** | Logistic regression is a dot product and a sigmoid. No Python on Vercel, no cold start, no `requirements.txt` for the grader |
| SQL | **PostgreSQL dialect**, `schema.sql` + `queries.sql` | Best dialect for showing type/constraint sense; graded by reading |
| UI | React + CSS modules, no framework | "No styling points." Full-width, large type, flat bordered panels |

**Runtime dependencies: `next`, `react`, `@google/genai`, `zod`.**

### 2.6 The scale path — shipped, not promised

The weakness in "I'll swap it later" is that nobody can check it. So the swap
point is an interface with two working implementations behind it.

```ts
export interface Retriever {
  readonly name: string;
  retrieve(query: string, opts: { k: number }): Promise<RankedSection[]>;
}
```

`RETRIEVER=lexical` (default) or `RETRIEVER=hybrid`. Everything downstream —
conflict detection, prompt assembly, citation verification — consumes
`RankedSection[]` and cannot tell which ran.

**`LexicalRetriever`** — BM25-style term scoring, heading boost, synonym
expansion. No API call, no index build, no cost, works offline. Correct at 20
sections, and the honest default.

**`HybridRetriever`** — the scale answer, and the reason this is worth building
rather than describing:

1. **Chunking** — heading-scoped, with the parent document's title and effective
   date prepended to each chunk before embedding. Chunks lose their context
   otherwise, which is the single most common reason a naive RAG system starts
   citing the wrong document.
2. **Embeddings** — Gemini's embedding model at build time, through the same key
   pool (§4), written to `lib/index.generated.json`. Query embeddings at request
   time — one extra call, ~100ms.
3. **Hybrid, not pure vector.** Dense retrieval alone is bad at exactly this
   domain: "2-bed Block B" and "3-bed Block A" are near-identical in embedding
   space, and MGC's corpus is full of near-identical rows differing by one token.
   Lexical scoring nails exact identifiers; dense scoring nails paraphrase
   ("handover" → "possession"). We need both.
4. **Reciprocal Rank Fusion** to combine them: `score = Σ 1/(60 + rank_i)`. Chosen
   over weighted score-blending because BM25 scores and cosine similarities are
   not on a common scale, and RRF needs no tuning to be sane — it works on ranks.
5. **Confidence gate + one reformulation** — the Corrective-RAG loop from §2.4.
   Top fused score below threshold → widen the query with synonyms, retrieve once
   more, and if it's still weak, tell the model the retrieval was weak so it can
   refuse rather than confabulate.

**Where each stage stops working, and what replaces it:**

| Corpus size | Retrieval | Index | Notes |
|---|---|---|---|
| ~20 sections (today) | `lexical`, `k = all` | none | Whole corpus in the prompt; conflict detection sees everything |
| ~50–500 chunks | `hybrid`, `k ≈ 12` | build-time JSON | Cross-document conflict detection still runs over the full index, not just top-k — deliberately |
| ~500–5,000 chunks | `hybrid` + a reranker over top-50 | build-time JSON, ~15 MB | JSON index still loads fine; embeddings dominate build time |
| 5,000+ chunks | `hybrid` | **pgvector** behind the `VectorStore` interface | Memory and cold-start stop being viable; ingestion moves to a queue |
| Multi-project corpora | + collection routing | per-project namespaces | This is where the graph in §2.4 earns its keep |

**One thing I will not let scale break.** Conflict detection (§3.5) currently
sees every section, which is why it cannot miss the transfer-fee contradiction.
Under top-k that guarantee dies — the two contradicting chunks may not both be
retrieved. So at the `hybrid` tier, conflicts are precomputed **at ingest time**
into a conflict registry keyed by topic, and looked up rather than rediscovered
per query. That keeps the property that makes this system trustworthy, at any
corpus size. It is the design decision I'm most confident about, and it's the one
a top-k-and-hope RAG pipeline gets wrong.

**Ingestion at that tier** is `scripts/ingest.ts`, offline: loaders (LangChain's,
per §2.3) → splitter → embed → conflict extraction → write index. Build-time
dependencies stay out of the serverless bundle entirely.

---

## 3. Part 1 — the grounded assistant

### 3.1 Corpus model

Documents split on markdown headings into typed sections:

```ts
type Section = {
  id: string;            // "price-list#location-premiums" — the citation key
  docId: "brochure" | "price-list" | "booking-policy";
  docTitle: string;
  heading: string;
  text: string;
  effectiveDate: string; // "2025-04-01" | "2025-03-01" | "2025-05-01"
  version: string;       // e.g. "v2.1"
};
```

`effectiveDate` and `version` come from the documents' own front matter
(*"Effective 1 April 2025. Supersedes the January 2025 list."*, *"Version 2.1,
updated May 2025"*). Not decoration — they're what makes the transfer-fee conflict
resolvable **by rule** instead of by vibe (§3.5).

`scripts/build-corpus.ts` emits `lib/corpus.generated.ts` in `prebuild`/`predev`,
so there's no filesystem read at request time and the corpus is type-checked.
~20 sections total.

### 3.2 Conversation state — stateless on purpose

Gemini's Interactions API can hold conversation state server-side via
`previous_interaction_id`. **I don't use it**, for two reasons that compound:

1. Server-side threads live inside the project that created them. My key pool
   (§4) deliberately spreads calls across *different projects* — turn 2 may be
   served by a different key than turn 1, and `previous_interaction_id` would be
   unresolvable. **Rotation and server-side state are mutually exclusive.**
2. Vercel functions are stateless anyway; owning the transcript client-side keeps
   the server a pure function of its input, which is far easier to reason about.

So: `store: false`, and I accumulate the transcript myself as an `input` array of
step objects, appending each turn's returned `steps` before the next
`user_input`. The documented stateless shape:

```ts
const history = [
  { type: "user_input", content: [{ type: "text", text: "…" }] },
];
const interaction = await ai.interactions.create({
  model, store: false, input: history, system_instruction, response_format,
});
history.push(...interaction.steps);
```

Transcript lives in the browser (`localStorage`) and is posted with each turn.
Capped at the last 8 turns — the corpus is re-sent every turn regardless, so long
history buys nothing but tokens.

### 3.3 Follow-up resolution

"And in Block A?" is meaningless to a retriever. Before scoring, I build a
**standalone query**: concatenate the previous user message with the current one
and run retrieval over the pair, then extract pricing slots (§3.4) from the merged
text so `{unitType: "2-bed"}` carries forward while `{block: "A"}` overrides.

Deliberately not an LLM call. Concatenation-plus-slot-merge handles the realistic
follow-ups on a fixed-vocabulary domain, costs nothing, and adds no latency. If it
proves too crude I'd add a cheap Flash-Lite rewrite call — noted in the README as
a known limitation rather than pre-built.

### 3.4 Deterministic pricing — the model never does arithmetic

`quote(slots) → QuoteTrace`. Slots filled from a closed vocabulary: block (`A`/`B`),
unit type (6 known), floor (integer regex), `corner`, `margalla`, payment mode.

Rules lifted straight from the price list, each carrying its citation:

| Rule | Value | Source |
|---|---|---|
| Floors 13–19 | +4% | price-list#location-premiums |
| Floors 20–22 | +7% | price-list#location-premiums |
| Corner unit | +3% | price-list#location-premiums |
| Margalla-facing | +6% | price-list#location-premiums |
| Premiums cumulative, additive on base | — | the document's own worked example |

Output is a **trace**, not a number:

```
base   2-Bed Standard, Block B, 1,150 sq ft   22,425,000
  +4%  floor 15 (band 13–19)                     897,000
  +3%  corner unit                               672,750
  +6%  Margalla-facing                         1,345,500
                                             ───────────
  total (base + 13%)                          25,340,250
  not included: parking 1,450,000 · utilities 285,000
                · maintenance advance 131,100 (12 × 9.50 × 1,150)
```

It enters the prompt as `COMPUTED (deterministic, from the price list)`. The
model presents it; it does not calculate it. LLM arithmetic on PKR millions is
precisely the confident-wrong-answer this brief tests for, and there's no reason
to take the risk.

**An ambiguity I surface rather than paper over.** Block B lists *2-Bed Corner* as
its own SKU at 26,855,000 (1,310 sq ft @ 20,500/sq ft) — "corner" is already
priced in. So "2-bed corner unit" has two readings:

- **(a)** 2-Bed Standard 22,425,000 + 4% + 3% + 6% = **25,340,250**
- **(b)** 2-Bed Corner 26,855,000 + 4% + 6% = **29,540,500**

The price list's own worked example — *"A Margalla-facing corner unit on floor 15
carries +4% +3% +6% = +13% over base"* — is literally this question and applies
the corner premium, pointing at (a). So the assistant leads with (a), shows the
arithmetic, and flags that a separately priced 2-Bed Corner SKU exists and the
salesperson should confirm which unit is meant. Flagging costs nothing; quoting
25.3M for a unit listed at 26.9M costs a sale or a refund.

### 3.5 Conflict detection — not left to the model

`detectConflicts(sections) → Conflict[]`. A conflict is **the same normalised
topic, different values, different documents**:

- A topic vocabulary of contestable facts (`transfer_fee`, `token_refund`,
  `possession_date`, `discount_rate`, …).
- Per section, extract `(topic, value, unit)` triples — percentages and PKR
  amounts near a topic keyword.
- Group by topic. One topic with ≥2 distinct values from ≥2 documents → a
  `Conflict` carrying both claims with section id, document title, effective date
  and version.

For the graded case:

```
CONFLICT · topic: transfer_fee
  2%   — Price List & Payment Plan (effective 2025-04-01), §Other Charges,
         scoped "before possession"
  2.5% — Booking Policy & Sales FAQ v2.1 (updated 2025-05-01), §Transfers,
         scoped "after confirmation + 4 cleared instalments"
  newer document: Booking Policy & Sales FAQ
```

Injected as a `CONFLICT` block with a hard instruction: present both values with
sources and dates, state which document is more recent, do not silently pick one,
tell the salesperson to confirm before quoting. **Recency is computed by me from
`effectiveDate`, not inferred by the model.**

Worth noting the two claims aren't cleanly contradictory — they're scoped to
different stages of the sale. Saying that is more useful than picking a winner.

### 3.6 The prompt

Assembled deterministically, three parts:

1. **`system_instruction`** — the grounding contract. Answer *only* from the
   supplied sections. Never infer, average or estimate. Every claim carries a
   section id. Not in the sections → say so and route to the marketing manager.
   Never quote bank mark-up rates or rental yields (MGC's own written policy,
   §3.7). Do not perform arithmetic — use the `COMPUTED` block if present.
2. **Context turn** — ranked sections, each wrapped with id, document title and
   effective date; then `CONFLICT` blocks; then any `COMPUTED` block.
3. **The transcript**, ending with the user's verbatim message.

`system_instruction` and the section list are byte-stable across requests, which
also means implicit context caching can work on them if it's enabled for the
model.

### 3.7 Output contract — refusal as a type, not a phrase

`response_format: { type: "text", mime_type: "application/json", schema }` with a
hand-written OpenAPI-subset schema (Gemini's `responseSchema` doesn't accept full
JSON Schema, so I write ~25 lines rather than fight a converter). The parsed
result is then validated a second time with Zod — belt and braces, since a
schema-constrained decode is not the same as a guarantee:

```ts
const AnswerSchema = z.object({
  status: z.enum([
    "answered",            // found it, clear source
    "conflict",            // sources disagree — both shown, neither picked
    "unconfirmed",         // documents say it exists but isn't decided yet
    "policy_refusal",      // documents explicitly forbid answering this
    "not_in_documents",    // simply absent
  ]),
  answer: z.string(),
  citations: z.array(z.object({
    sectionId: z.string(),
    documentTitle: z.string(),
    quote: z.string(),     // verbatim supporting text, checked in §3.8
  })),
  caveats: z.array(z.string()),
  escalateTo: z.string().nullable(),   // "marketing manager" | null
});
```

Refusal as a *state* means the chat bubble renders differently (amber, no number
shown, escalation contact surfaced) and I can assert on it in the route. A model
emitting `not_in_documents` cannot accidentally also render a number in an
answer-styled bubble.

The five statuses map onto the graded questions:

| Question | Status | Behaviour |
|---|---|---|
| Base price of a 2-bed in Block B? | `answered` | 22,425,000 (Standard, 1,150 sq ft), cites price-list#block-b; notes the 2-Bed Corner line at 26,855,000 also exists |
| Total for Margalla-facing corner, floor 15, 2-bed Block B? | `answered` + caveats | Deterministic trace → 25,340,250; caveat for reading (b); caveat that parking/utilities/maintenance are extra |
| What's the transfer fee? | `conflict` | 2% (price list, Apr 2025) **and** 2.5% (FAQ v2.1, May 2025), both scoped, FAQ flagged newer, escalate before quoting |
| Rental yield on a 1-bed? | `policy_refusal` | **Not** merely absent — the FAQ *explicitly* says MGC publishes no yield projections and staff must not give them verbally. Cite that, route to the marketing manager |
| Who is the anchor tenant? | `unconfirmed` | Brochure §Commercial Podium: discussions ongoing, none confirmed as of issue. Say exactly that; don't guess a brand |

The rental-yield distinction is the one I'd most want noticed. "I don't know" and
"I'm not permitted to tell you, here's who can" are different answers, and the
documents support the stronger one.

**Why not streaming.** Structured output and token streaming pull against each
other — you cannot safely render half-parsed JSON, and a partially-decoded refusal
rendered as an answer is the exact failure mode this design exists to prevent.
Flash returns in ~1–3s, so the chat shows a typing indicator and commits the
whole validated message at once. Streaming the prose while computing citations
deterministically is a real upgrade path; it's in the README as next steps, not
in the hour.

### 3.8 Post-validation (cheap insurance)

After the call, before returning:

- Every `citations[].sectionId` must exist in the corpus. Unknown id → the model
  invented a source → force `status: "not_in_documents"`.
- Every `citations[].quote` must appear (whitespace-normalised) in that section's
  text. Fails → drop the citation; none survive on an `answered` → downgrade.
- If `status === "answered"` while a `CONFLICT` block covering the question's
  topic was in context → force `"conflict"`. **The deterministic layer wins over
  the model.**

~30 lines. Turns "the prompt says don't hallucinate" into "a hallucinated source
is caught and downgraded".

### 3.9 Running with zero keys

The grader's first criterion is *does it run on our machine without back-and-forth*.
Requiring them to hold Gemini keys is a real risk to that.

If the key pool is empty, `/api/chat` falls back to a deterministic extractive
answerer — retrieval + conflict registry + pricing calculator rendered through
templates, labelled `offline mode · no API key configured` in the UI. It still
answers all five graded questions correctly, because in this architecture the
hard parts were never the model's job. It just answers them woodenly.

With keys it's the full Gemini path — the default, and what the live URL runs.
A fallback, not the product, but it means the repo can never fail to demo.

---

## 4. The Gemini key rotation pool

### 4.1 The finding that shapes this — read this first

Google's documentation is explicit:

> *"Rate limits are applied per project, not per API key."*
> — [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

**So generating five keys inside one Google Cloud project buys nothing.** They all
draw from the same RPM/TPM/RPD bucket and will 429 together. For rotation to
increase real throughput, each key must belong to a **separate project** (and for
free-tier headroom, in practice a separate account).

This is worth stating plainly in the README too, because it is the difference
between a rotation layer that works and one that looks like it works. What the
pool still buys inside a single project:

- **Failover** — one revoked/misconfigured key doesn't take the app down.
- **Backpressure** — a shared 429 puts *all* keys into cooldown, and the pool
  turns that into a clean "busy, retry in Ns" instead of a stack trace.
- **Zero-downtime key rotation** — swap a key in the env without a redeploy gap.

I'll configure it with keys from distinct projects, and document both facts.

### 4.2 Configuration

One env var, N keys:

```bash
GEMINI_API_KEYS=AIza...key1,AIza...key2,AIza...key3
GEMINI_MODEL=gemini-3.5-flash
```

Also accepts `GEMINI_API_KEY_1..N` because Vercel's dashboard is friendlier to
separate variables. Parsed once at module load, trimmed, deduplicated, empties
dropped.

### 4.3 Pool state

`lib/gemini/keyPool.ts` — one `GoogleGenAI` client per key, created once and
cached in a `Map` (client construction is cheap but not free, and reuse keeps
keep-alive connections warm).

```ts
type KeyState = {
  index: number;
  label: string;          // "key#2 (…a3f9)" — last 4 chars only, never the key
  client: GoogleGenAI;
  inFlight: number;
  cooldownUntil: number;  // epoch ms; 0 = available
  consecutiveFailures: number;
  disabled: boolean;      // permanently, on auth failure
  totalCalls: number;
  totalFailures: number;
};
```

### 4.4 Selection strategy

Not naive round-robin — **least-loaded among eligible, round-robin as tiebreak**:

1. Filter to keys that are not `disabled` and whose `cooldownUntil` has passed.
2. Pick the minimum `inFlight` (so a slow call doesn't pile more onto the same key).
3. Tie → advance a module-level cursor. Keeps distribution even at low concurrency.
4. No eligible key → sleep until the earliest `cooldownUntil` (capped at 5s), then
   re-check once. Still nothing → throw `AllKeysExhaustedError`.

### 4.5 Error classification — the part that makes it real

Rotation is only as good as its error handling. Every failure is classified, and
the class decides the response:

| Condition | Classification | Action |
|---|---|---|
| HTTP 429 / `RESOURCE_EXHAUSTED` | Rate limited | Cooldown this key. Honour the `RetryInfo.retryDelay` in the error body when present; else exponential backoff `min(60s, 2^failures × 1s)` with ±20% jitter. **Retry on the next key.** |
| HTTP 401 / 403 / `API_KEY_INVALID` | Dead key | `disabled = true`, log once at error level. Never retried — burning attempts on a revoked key is how a pool turns into a slow failure. |
| HTTP 500 / 503 / `UNAVAILABLE` | Transient upstream | 2s cooldown, retry next key. |
| Network / timeout (10s cap) | Transient | 2s cooldown, retry next key. |
| HTTP 400 / schema rejection | **My bug** | Do **not** rotate — no other key will like it better. Fail fast and surface it. |
| Success | — | `consecutiveFailures = 0`, cooldown cleared. |

`callWithRotation(fn)` wraps a call and tries up to `min(pool.size, 4)` distinct
keys. Exhausted → the route returns 503 and the chat renders a system bubble:
*"All API keys are rate limited. Retrying in Ns."* — not a stack trace.

Distinguishing 400 from 429 matters more than it looks. A pool that retries
everything turns one malformed schema into N wasted calls and an error message
blaming quota.

### 4.6 The honest caveat: serverless state

Pool state is module-level memory, which on Vercel means **per function instance**.
Under concurrency, several instances each keep their own view of which keys are
cooling down, so a key can be tried by instance B while instance A is backing off.

I'm accepting that, and saying so, because:

- Cooldowns are advisory and self-correcting — a duplicate 429 just re-cools it.
- The alternative (Upstash Redis / Vercel KV holding shared cooldown state) adds a
  network round trip to every LLM call and a service to the run instructions, for
  a demo that will see single-digit concurrency.

The fix is named in the code comment and in the README's "with more time". I'd
rather ship a correct-at-one-instance pool I can explain than a distributed one I
can't defend.

### 4.7 Observability

- `GET /api/health` → `{ keysConfigured, available, coolingDown, disabled, model }`.
  Never key material. Makes "is it the pool or the model?" a one-second question
  during a demo.
- Every rotation logs one line: `[keypool] key#2 (…a3f9) 429 → cooldown 4200ms, retrying key#3 (…7b1c)`.
- Per-request response header `x-gemini-key: key#2` so the browser network tab
  shows rotation happening. Index only, never the secret.

---

## 5. Part 2 — schema & queries

### 5.1 What the data actually looks like

Profiled `leads.csv` before designing anything (9,160 rows, 20 columns):

| Finding | Number | Schema consequence |
|---|---|---|
| `converted` positives | 634 / 9,160 = **6.92%** | `boolean NOT NULL DEFAULT false` |
| Exact duplicate leads | **160 pairs**, always multiplicity 2 | Second copy has `lead_id` suffixed `-B` and an *identical* `crm_record_hash` |
| Distinct `crm_record_hash` | 9,000 (= 9,160 − 160) | The CRM's own record fingerprint → the natural key |
| `city` spellings | 21 distinct for **9 real cities** (`Islamabad`/`ISLAMABAD`/`ISB`; `Rawalpindi`/`RAWALPINDI`/`Rwp`; `Karachi`/`KARACHI`/`khi`, …) | Lookup table + alias table, not free text |
| `bedrooms` missing | 3,602 (39.3%) | **Exactly** the 2,553 `Plot` + 1,049 `Commercial Shop` rows. Not missing — structurally inapplicable |
| `area` missing | 477 (5.2%) | Genuinely not captured → nullable FK |
| `source` | 9 stable values | ENUM |
| `property_type` | 6 stable values | ENUM |
| `token_amount_received_pkr` | positive ⇒ converted in 634/719; zero ⇒ converted in **0** | A *booking* fact, not a lead attribute (§5.3) |

### 5.2 Shape: staging → clean

```sql
lead_raw            -- everything text, no constraints, mirrors the CSV 1:1
   ↓ (normalise + dedupe)
lead                -- typed, constrained, one row per real enquiry
lead_engagement     -- 1:1, mutable operational counters
city / city_alias   -- canonical cities + the messy spellings that map to them
area                -- lookup, nullable from lead
```

**Why staging.** A messy CRM dump cannot land in a constrained table — the first
duplicate aborts the load. `lead_raw` accepts everything; the transform into
`lead` is where normalisation and dedup happen, auditably. It also gives the
duplicate-finding query something to run *against*: in the clean table duplicates
cannot exist by construction.

**Why `city_alias`.** `'ISB'`, `'isb'`, `'Islamabad'` are one city. A table rather
than a `CASE` buried in an ETL script means the next unseen spelling is one
`INSERT`, not a code change.

**Why split `lead_engagement`.** `lead` rows are write-once intake facts; calls,
call seconds, WhatsApp replies and site visits are counters that change on every
touch. Separating them keeps the intake row immutable and is the natural stepping
stone to a real `lead_touch` event table, of which these are a rollup. That gets a
comment, not an implementation — for 9,000 rows and ~10 minutes, the 1:1 rollup is
the honest amount of structure.

**Constraints that encode findings:**

```sql
CHECK (budget_pkr_lac IS NULL OR budget_pkr_lac > 0)
CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 10)
-- bedrooms are inapplicable, not missing, for land and retail:
CHECK (
  (property_type IN ('Plot','Commercial Shop') AND bedrooms IS NULL)
  OR property_type NOT IN ('Plot','Commercial Shop')
)
```

That last one is §5.1's finding stated in the schema: for 3,602 rows NULL means
"does not apply", and the database should refuse a plot with three bedrooms.

### 5.3 Keys, and how duplicates get prevented

```sql
lead_id            text PRIMARY KEY        -- the CRM's own id, kept for traceability
crm_record_hash    bigint NOT NULL
CREATE UNIQUE INDEX lead_crm_record_hash_key ON lead (crm_record_hash);
```

`lead_id` is the PK because it's what the CRM and the sales team use. But it does
**not** identify a *person* — that's the whole duplicate problem: `MGC-104183` and
`MGC-104183-B` are one enquiry entered twice. `crm_record_hash` is the CRM's
fingerprint of the underlying person + enquiry, so **`UNIQUE (crm_record_hash)` is
what makes the second entry impossible.** Ingest runs
`INSERT … ON CONFLICT (crm_record_hash) DO NOTHING` — the second agent's entry is
rejected at write time, not discovered in analysis six months later.

Comment I'll write alongside it: in a real CRM I'd rather the identity were a
*generated* column over normalised phone/CNIC — `UNIQUE (normalise_phone(phone))`
— because a vendor hash is opaque and I can't verify its inputs. This dataset has
no phone or CNIC, so the hash is the best available natural key, and the design
makes swapping it a one-line change.

I will **not** key on the `-B` suffix. It identifies all 160 duplicates here, but
it's a naming convention, not a constraint, and the next agent will use `_dup`.

### 5.4 The two queries

**Q1 — conversion rate by source, 200+ leads, best first.** `GROUP BY source`,
`HAVING count(*) >= 200`, `ORDER BY rate DESC`. Runs against the deduplicated
`lead` table on purpose — counting a duplicated lead twice biases whichever source
got double-entered. Measured output:

| source | leads | converted | rate |
|---|---|---|---|
| Referral | 730 | 95 | 13.01% |
| Walk-in | 610 | 63 | 10.33% |
| Facebook Ads | 2,366 | 160 | 6.76% |
| Google Search | 1,460 | 96 | 6.58% |
| WhatsApp Campaign | 548 | 35 | 6.39% |
| Property Portal | 1,812 | 108 | 5.96% |
| Instagram | 1,007 | 55 | 5.46% |

(Expo Stall 345 and Billboard 282 also clear 200. Referral and Walk-in at roughly
2× everything else is the finding a sales manager actually wants.)

**Q2 — duplicate finder.** Two levels, both against `lead_raw`:

1. *Exact* — `GROUP BY crm_record_hash HAVING count(*) > 1`, with
   `array_agg(lead_id)` to show the pair. Finds all 160.
2. *Fuzzy* — self-join on `(source, city_normalised, property_type,
   budget_pkr_lac)` where `created_at` is within an hour and `lead_id` differs.
   Catches what the hash misses: two agents typing the same walk-in with a typo,
   so the fingerprints differ. This is the query that survives the vendor changing
   its hashing.

The comment above them says what §5.3 says: the unique index is the *prevention*;
these queries are the *detection* you need for the data you already have.

---

## 6. Part 3 — lead scoring

### 6.1 Cleaning and column decisions (measured, not assumed)

**Dropped — identifiers:** `lead_id`, `crm_record_hash`. No predictive content, and
as a number the hash would let a tree model memorise individual rows.

**Dropped — target leak:** `token_amount_received_pkr`.

> Measured: token = 0 → **0 of 8,441** converted. Token > 0 → **634 of 719**
> converted. The token *is* the booking. A model with this column scores ~0.99 AUC
> and is worthless, because at the moment you need a score — fresh lead, nobody
> has called — the value is always zero. This is the column the exercise is
> testing for, and dropping it is the single most important decision in Part 3.

**Held out of the deployed model — post-contact engagement:** `calls_made`,
`total_call_seconds`, `whatsapp_replies`, `site_visits`, `first_response_minutes`.

> Not statistical leaks — *temporal* ones. `site_visits` is enormously predictive
> (0 visits → 4.0%, 1 → 9.7%, 2 → 21.3%, 3 → 43.8%), but the business question is
> **"who do I call first?"**, asked when the lead arrives and every one of these
> is zero. A model needing them can't answer the question it was built for.
>
> So: **two models**, both reported.
> - **Model A (intake-only)** — deployable, the headline number, wired into the page.
> - **Model B (with engagement)** — diagnostic only: how much signal lives in
>   engagement, and a pipeline sanity check.
>
> Reporting A as the honest number while showing B exists is the point. B will
> look much better and be much less useful.

**Fixed:**
- **Duplicates** — drop the 160 `-B` rows by `crm_record_hash`, **before** the
  train/test split. Deduplicating after would put identical rows on both sides and
  inflate the test score.
- **City** — 21 spellings → 9 canonical (uppercase + explicit `ISB→Islamabad`,
  `Rwp→Rawalpindi`, `khi→Karachi`). Left raw, the encoder learns three separate
  weak "Islamabad" features.
- **`bedrooms`** — 39.3% missing, fully explained by `property_type ∈ {Plot,
  Commercial Shop}`. Treated as **categorical with an explicit `not_applicable`
  level**, never median-imputed. Imputing 3 bedrooms into a plot of land invents a
  fact. It's then partly collinear with `property_type` — fine for a regularised
  linear baseline, and I'd rather say so than hide it.
- **`area`** — 477 missing → explicit `"Unknown"` level. Missing-because-nobody-asked
  may itself be signal about lead quality.
- **`budget_pkr_lac`** — 3.1% missing → median impute **plus a `budget_missing`
  flag**. Range 18–1,421 lac, heavy right tail → add `log1p(budget)`.
- **`agent_experience_years`** — 4.4% missing → median + flag. It's a property of
  the *agent*, not the lead. Kept (it measurably matters) but flagged in the README
  as a causality caveat: optimising it means "route good leads to senior agents",
  a staffing decision, not a lead score.
- **`first_response_minutes`** — 1–3,107, median 30. Out of Model A on timing
  grounds; `log1p` in Model B.
- **`created_at`** — as `hour_of_day`, `day_of_week`, `month`. A 2 a.m. portal form
  is a different animal from a 3 p.m. walk-in.

**Kept as-is:** `source`, `city_normalised`, `area`, `property_type`, `is_overseas`,
`referred_by_existing_client`, `has_financing_approved`. Measured base rates:

| flag | rate at 0 | rate at 1 |
|---|---|---|
| `referred_by_existing_client` | 5.67% | **19.54%** |
| `has_financing_approved` | 5.73% | 11.36% |
| `is_overseas` | 7.35% | 4.90% |

### 6.2 Model

`sklearn.Pipeline`:
`ColumnTransformer(OneHotEncoder(handle_unknown="ignore") | SimpleImputer(median) + StandardScaler)`
→ `LogisticRegression(class_weight="balanced", max_iter=1000)`.

Stratified 80/20 split, `random_state=42`. **No tuning** — the brief says baseline,
and an untuned baseline I can explain beats a tuned one I can't.

Two more reasons logistic regression is right beyond "it's the baseline":
coefficients are directly inspectable (a sales manager can be shown *why* a lead
scored high), and the fitted model exports to ~40 lines of JSON that TypeScript can
evaluate — which is what makes §7 deployable on Vercel with no Python. Gradient
boosting would probably win a point or two of average precision and cost both.

### 6.3 Metric

**Headline: PR-AUC (average precision).** The class balance decides it.

- **Accuracy is useless.** "Nobody converts" scores **93.08%** and creates zero
  value. Any accuracy number here is one I'd be embarrassed to defend.
- **ROC-AUC is flattering.** With 8,526 negatives, a large absolute number of false
  positives barely moves the false-positive *rate*, so ROC-AUC looks respectable
  even when the top of the ranking is mostly noise.
- **PR-AUC only rewards the positive class**, which is the one we care about, and
  its no-skill baseline is the prevalence itself — **0.0692** — so the number
  arrives with its own "did this beat nothing?" reference.

**Alongside: precision@200.** The deployment is a ranked call list and the team can
work ~200 leads. "Of the top 200 this model ranks, how many convert?" against a
6.92% baseline is what a sales manager can act on, and it keeps me honest that
PR-AUC is a summary while the business only sees the top of the list.

Also printing the confusion matrix at threshold 0.5, and saying plainly that 0.5 is
the wrong operating point for a ranking task — the threshold should come from call
capacity, not from a default.

I'm committing to reporting whatever Model A produces, mediocre or not. A modest,
honest AP on intake-only features is the correct answer here; 0.95 would mean I'd
left the leak in.

### 6.4 Export for serving

`train.py` writes `ml/model.json`:

```json
{
  "intercept": -2.7,
  "numeric":    [{ "name": "log_budget", "impute": 4.75, "mean": 4.7, "scale": 0.8, "coef": 0.13 }],
  "categorical":[{ "name": "source", "coefs": { "Referral": 0.71 }, "unknown": 0.0 }],
  "meta": { "trained_at": "...", "n_train": 7200, "average_precision": 0.0, "prevalence": 0.0692 }
}
```

`lib/score.ts` reads it: impute → standardise → dot product → sigmoid.
Deliberately boring, and the grader needs Node only.

---

## 7. Part 4 — the interface

Single route `/`, two panels. Chat is the primary surface; scoring is the side
panel. The brief accepts either; both is the stated bonus.

**Main — the copilot chat.**
- Message thread with role-styled bubbles, transcript in `localStorage`, "New chat"
  clears it.
- Typing indicator while the turn is in flight (§3.7 explains why not streaming).
- Five suggested prompts as starter chips — the graded questions, one click each,
  so the grader hits every hard case without typing.
- Under each assistant message, a **Sources** block: `documentTitle › heading` with
  the verbatim quote, collapsed by default, expandable.
- Status-driven rendering, which is the point:
  - `answered` — normal bubble + sources.
  - `conflict` — amber bordered bubble, **both** values side by side with document
    and date, neither promoted, escalation line.
  - `unconfirmed` / `policy_refusal` / `not_in_documents` — grey bubble, **no number
    rendered anywhere**, "ask the marketing manager" as the action.
- A small footer line showing model + which key index served the turn (§4.7) — a
  demo affordance that makes rotation visible.

**Side — Score a lead.** Intake fields only (source, city, area, property type,
budget, bedrooms, overseas, referred, financing, agent experience). The form
*cannot* ask for engagement data, which is §6.1's argument made visible. Submit →
`POST /api/score` → probability, a Low/Medium/High band, and the three strongest
contributing coefficients so the salesperson sees *why*.

Styling: full-width, large type, flat panels, visible borders, minimal copy. No CSS
framework.

**Routes:** `POST /api/chat`, `POST /api/score`, `GET /api/health`.

---

## 8. Repository layout

```
mgc-task-chatbot/
├── README.md                     # run steps, key setup, data decisions, metric, what's unfinished
├── DESIGN.md                     # this file
├── .env.example                  # GEMINI_API_KEYS=, GEMINI_MODEL=
│
├── mgc-task-pack/                # unmodified inputs, committed as received
│
├── sql/
│   ├── schema.sql                # Part 2
│   └── queries.sql               # Part 2
│
├── ml/
│   ├── train.py                  # Part 3 — clean, split, fit, evaluate, export
│   ├── requirements.txt
│   ├── metrics.md                # generated: the honest numbers
│   └── model.json                # generated: coefficients for the TS scorer
│
├── lib/
│   ├── gemini/
│   │   ├── keyPool.ts            # §4 — selection, cooldown, error classification
│   │   └── client.ts             # callWithRotation + the interactions.create wrapper
│   ├── corpus.generated.ts       # built from docs/
│   ├── retrieve.ts
│   ├── conflicts.ts
│   ├── pricing.ts
│   ├── answer.ts                 # prompt assembly + the call + validation
│   ├── offline.ts                # §3.9 deterministic fallback
│   └── score.ts
│
├── app/
│   ├── page.tsx
│   ├── components/               # Chat, Message, SourceCard, ScorePanel
│   └── api/{chat,score,health}/route.ts
│
└── scripts/build-corpus.ts
```

---

## 9. Deployment

- `next build`; `prebuild` runs `scripts/build-corpus.ts`.
- Vercel env: `GEMINI_API_KEYS` (comma-separated, **keys from distinct projects** —
  §4.1), `GEMINI_MODEL`. Absent → offline mode (§3.9).
- Routes are Node-runtime handlers. `model.json` and the corpus are imported
  modules — no filesystem access at request time, no cold-start data loading.
- No database at runtime. Part 2 is graded as SQL files; wiring Postgres would
  spend time on something the brief says it isn't grading.
- Live URL goes in the submission's optional field. Repo-runs-locally stays primary.

---

## 10. Build order (time-boxed, with a ship line)

Ordered so stopping at any point still leaves a coherent submission. The brief's own
advice — *"finishing two parts well beats rushing four"* — is the tiebreaker.

| # | Block | Est. | Cum. |
|---|---|---|---|
| 1 | Scaffold Next + corpus builder + sections | 10 min | 0:10 |
| 2 | `keyPool.ts` + `callWithRotation` + `/api/health` | 20 min | 0:30 |
| 3 | `Retriever` interface + `LexicalRetriever` + `conflicts` + `pricing` | 20 min | 0:50 |
| 4 | `answer.ts` — prompt, schema, Gemini call, citation validation | 20 min | 1:10 |
| 5 | `/api/chat` + chat UI, verify all five graded questions | 20 min | 1:30 |
| 6 | `HybridRetriever` — ingest/embed script, RRF, confidence gate | 25 min | 1:55 |
| 7 | `schema.sql` + `queries.sql` | 15 min | 2:10 |
| 8 | `train.py` — clean, split, fit, metrics, export `model.json` | 20 min | 2:30 |
| 9 | `/api/score` (no UI panel — see cut decision) | 5 min | 2:35 |
| 10 | README (run steps, key setup, data decisions, metric, unfinished) | 15 min | 2:50 |
| 11 | Push, deploy, submit | 10 min | 3:00 |

**Scope decision taken at design time:** the lead-scoring **UI panel** is cut in
favour of the hybrid retriever (⑥). Part 3 still ships completely — `train.py`,
`metrics.md`, `model.json`, and a working `/api/score` endpoint — it just has no
form in front of it. Reasoning: Part 4 is graded on "working at all" and the chat
surface satisfies it, while ⑥ is the difference between a scale story that is a
code path and one that is a paragraph. The README says this explicitly rather
than leaving the grader to notice.

**Ship line:** stop building at deadline − 20 min regardless of state and spend
those 20 on the README and the push. An unpushed repo scores zero; a README saying
"the retriever ships both strategies but /api/score has no UI" is explicitly
described in the brief as a hireable submission.

**Cut order if short:** ⑨ → ⑥'s confidence gate (keep RRF) → Model B → the fuzzy
duplicate query → offline mode → `/api/health`.
**Never cut:** the five graded questions working in the chat, and the README.

---

## 11. Answers to the submission form questions

**How does the system handle a question the documents don't answer?**
It distinguishes three kinds of "no". Absent → `not_in_documents`. Present but
explicitly undecided (anchor tenant) → `unconfirmed`, quoting the brochure's own
wording. Present as a *prohibition* (rental yield) → `policy_refusal`, citing the
FAQ line that forbids staff from projecting and routing to the marketing manager.
Refusal is a typed status the UI renders as a non-answer, and a post-check
downgrades any response whose citations don't resolve to real sections.

**What did you clean, change or drop, and why?**
Dropped `token_amount_received_pkr` — token received *is* the booking, a perfect
leak, and always zero when you'd actually score a lead. Held the five post-contact
engagement columns out of the deployed model for the same reason in time rather
than in logic. Deduplicated 160 repeated leads on `crm_record_hash` before
splitting. Normalised 21 city spellings to 9. Treated `bedrooms` as inapplicable
rather than missing — its 39.3% NULL rate is exactly the plot and commercial-shop
rows. Median-imputed budget and agent experience with missingness flags.

**Which metric, and why?**
PR-AUC (average precision), with precision@200 alongside. 6.92% positives means
accuracy is 93% for predicting nothing, and ROC-AUC is flattered by 8,526 negatives
absorbing false positives. PR-AUC scores only the class we care about and carries
its own no-skill baseline (0.0692). Precision@200 is the number the sales team can
act on, because the deliverable is a ranked call list.

**What's unfinished?**
[Filled in truthfully at submission — the ship line guarantees there's something.]

**Which AI tools, and where did they help or get in the way?**
Claude (Claude Code) throughout. Fastest at scaffolding, the SQL and the sklearn
pipeline. Where I overruled it: the reflex on Part 1 is always "embed, chunk,
vector store" — on a 2,000-token corpus that's the wrong architecture and it breaks
the transfer-fee question specifically, so retrieval here ranks citations rather
than discarding context. I also kept arithmetic and conflict detection out of the
model entirely, because those are the two places a confident wrong answer costs a
sale. And I checked the rate-limit docs rather than assuming: Gemini quota is
per-project, not per-key, which changed how the rotation pool has to be configured.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Grader has no Gemini key | Offline deterministic mode (§3.9) — all five questions still answer |
| Free-tier quota dies mid-demo | Key pool with cooldown + failover (§4); `/api/health` makes the state visible |
| Keys all in one project → rotation is theatre | Documented in §4.1 and the README; keys sourced from distinct projects |
| Model returns unparseable JSON | `response_format` schema + Zod re-validation; parse failure → `not_in_documents`, not a 500 |
| Model picks one transfer-fee value anyway | Deterministic conflict block + post-check forcing `status: "conflict"` (§3.8) |
| Price arithmetic wrong | The model never does it — `pricing.ts` does, and shows the trace |
| Corner-unit ambiguity read wrong | Both readings surfaced; the doc's own worked example sets the default (§3.4) |
| Gemini model IDs move | Model is one env var, never a literal; default verified against the docs at build time |
| No pandas/sklearn locally | `pip install -r ml/requirements.txt` at step ⑦; `model.json` is committed so the app never needs Python |
| Time | Ship line at deadline − 20 min, explicit cut order (§10) |

---

## 13. One-line summary of the stack argument

> The corpus is 2,000 tokens, so retrieval isn't a context problem — it's a citation
> problem. The flow is a straight line, so it isn't a graph. There's one provider,
> so there's nothing to abstract over — what there *is*, is a pool of keys that
> needs real error classification, and that's easier to own than to configure. That
> leaves Next.js, `@google/genai`, and about 500 lines I can defend line by line —
> which is the stated grading criterion.
