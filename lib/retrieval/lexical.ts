/**
 * Lexical retriever — BM25-style term scoring over the section index.
 *
 * The default strategy. At 22 sections this beats embeddings on every axis that
 * matters: no API call, no index build, no cost, works with zero keys, and it is
 * exact on the identifiers this domain is full of ("Block B", "2-bed", "floor 15")
 * where dense vectors are weakest.
 *
 * The scale story is lib/retrieval/hybrid.ts, behind the same interface.
 */
import { CORPUS } from "../corpus.generated";
import type {
  RankedSection,
  RetrievalResult,
  RetrieveOptions,
  Retriever,
  Section,
} from "../types";

/** BM25 term-frequency saturation. Standard value; nothing here justifies tuning it. */
const K1 = 1.2;
/** BM25 length normalisation. */
const B = 0.75;
/** How many top-scored sections get flagged as focus in the prompt. */
const FOCUS_COUNT = 5;
/** A match in the heading is worth this many body matches. */
const HEADING_BOOST = 2.5;

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","by","can","do","does","for","from","had",
  "has","have","how","i","if","in","is","it","its","me","of","on","or","our",
  "please","tell","that","the","their","then","there","these","this","to","was",
  "we","what","when","where","which","who","why","will","with","you","your",
]);

/**
 * Bridges the gap between how a salesperson talks and how the documents are
 * written. Every entry earns its place against a real question:
 *   "rental yield?"      → the FAQ says "rental yield projections"
 *   "when do I get keys" → the documents say "possession", never "handover"
 *   "anchor tenant?"     → the brochure says "anchor tenancy discussions"
 */
const SYNONYMS: Record<string, string[]> = {
  yield: ["rental", "projection", "projections", "return"],
  rental: ["yield", "projection"],
  transfer: ["transfer", "fee", "transferred"],
  fee: ["fee", "charge", "charges"],
  anchor: ["anchor", "tenant", "tenancy", "commercial", "podium"],
  tenant: ["anchor", "tenancy", "commercial"],
  handover: ["possession", "completion", "handover"],
  keys: ["possession", "handover"],
  discount: ["discount", "cash", "upfront", "overseas", "rebate"],
  instalment: ["instalment", "installment", "quarterly", "payment", "plan"],
  installment: ["instalment", "quarterly", "payment", "plan"],
  price: ["price", "prices", "base", "cost", "rate"],
  cost: ["price", "base", "charges"],
  premium: ["premium", "premiums", "corner", "margalla", "floor"],
  refund: ["refund", "refundable", "cancel", "cancellation", "deduction"],
  cancel: ["cancellation", "refund", "refundable"],
  loan: ["financing", "bank", "mark-up", "markup", "home"],
  financing: ["loan", "bank", "mark-up"],
  parking: ["parking", "slot", "basement"],
  gas: ["gas", "sui", "connection"],
  bed: ["bed", "bedroom"],
  "2-bed": ["2-bed", "2", "bed", "two"],
  "1-bed": ["1-bed", "1", "bed", "one"],
  "3-bed": ["3-bed", "3", "bed", "three"],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Keep digits attached to words so "2-bed" and "floor 15" survive.
    .replace(/[^a-z0-9\-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Query tokens plus their synonyms, deduplicated. */
function expandQuery(query: string): string[] {
  const base = tokenize(query);
  const expanded = new Set(base);
  for (const token of base) {
    for (const syn of SYNONYMS[token] ?? []) expanded.add(syn);
  }
  return [...expanded];
}

type IndexEntry = {
  section: Section;
  bodyTokens: string[];
  headingTokens: Set<string>;
  /** Term → count, precomputed so scoring is a lookup rather than a scan. */
  termFreq: Map<string, number>;
  length: number;
};

/**
 * Index built once at module load. The corpus is a compile-time constant, so
 * there is nothing to invalidate and no reason to rebuild per request.
 */
const INDEX: IndexEntry[] = CORPUS.map((section) => {
  const bodyTokens = tokenize(`${section.heading} ${section.text}`);
  const termFreq = new Map<string, number>();
  for (const t of bodyTokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return {
    section,
    bodyTokens,
    headingTokens: new Set(tokenize(section.heading)),
    termFreq,
    length: bodyTokens.length,
  };
});

const AVG_LENGTH =
  INDEX.reduce((sum, e) => sum + e.length, 0) / Math.max(1, INDEX.length);

/** Document frequency per term, for IDF. */
const DOC_FREQ = new Map<string, number>();
for (const entry of INDEX) {
  for (const term of new Set(entry.bodyTokens)) {
    DOC_FREQ.set(term, (DOC_FREQ.get(term) ?? 0) + 1);
  }
}

function idf(term: string): number {
  const n = INDEX.length;
  const df = DOC_FREQ.get(term) ?? 0;
  // BM25's IDF with the +1 that keeps it non-negative for terms in every doc.
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function scoreSection(entry: IndexEntry, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    const tf = entry.termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const norm = 1 - B + B * (entry.length / AVG_LENGTH);
    const bm25 = idf(term) * ((tf * (K1 + 1)) / (tf + K1 * norm));
    const boost = entry.headingTokens.has(term) ? HEADING_BOOST : 1;
    score += bm25 * boost;
  }
  return score;
}

export class LexicalRetriever implements Retriever {
  readonly name = "lexical";

  async retrieve(
    query: string,
    opts: RetrieveOptions,
  ): Promise<RetrievalResult> {
    const terms = expandQuery(query);

    const scored: RankedSection[] = INDEX.map((entry) => ({
      ...entry.section,
      score: scoreSection(entry, terms),
      isFocus: false,
    })).sort((a, b) => b.score - a.score);

    for (let i = 0; i < Math.min(FOCUS_COUNT, scored.length); i++) {
      // Only flag as focus if it actually matched something.
      if (scored[i].score > 0) scored[i].isFocus = true;
    }

    const sections = Number.isFinite(opts.k) ? scored.slice(0, opts.k) : scored;
    const max = scored[0]?.score ?? 0;

    return {
      sections,
      strategy: this.name,
      // Normalised against a rough "a good match scores ~8" ceiling so the
      // confidence gate in answer.ts has a scale-free number to threshold on.
      topScore: Math.min(1, max / 8),
    };
  }
}
