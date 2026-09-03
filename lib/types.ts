/**
 * Shared domain types.
 *
 * Everything downstream of retrieval consumes `RankedSection[]` and cannot tell
 * which Retriever implementation produced it. That is the seam described in
 * DESIGN.md §2.6 — it is what makes swapping lexical → hybrid a config change
 * rather than a rewrite.
 */

/** One heading-scoped slice of a source document. The unit of citation. */
export type Section = {
  /** Stable citation key, e.g. "price-list#location-premiums". */
  id: string;
  docId: DocId;
  /** Human-readable, shown to the salesperson in the source card. */
  docTitle: string;
  heading: string;
  text: string;
  /**
   * ISO date the document took effect. Lifted from the document's own front
   * matter, not invented. This is what lets conflict resolution say which of two
   * contradicting claims is newer (DESIGN.md §3.5).
   */
  effectiveDate: string;
  version: string;
};

export type DocId = "brochure" | "price-list" | "booking-policy";

export type RankedSection = Section & {
  /** Retriever-specific relevance score. Only meaningful for ranking within one result set. */
  score: number;
  /** Marks the top matches so the prompt can flag them as focus without dropping the rest. */
  isFocus: boolean;
};

export type RetrieveOptions = {
  /** Number of sections to return. `Infinity` means "all", which is the default at this corpus size. */
  k: number;
};

export type RetrievalResult = {
  sections: RankedSection[];
  /** Which implementation ran, surfaced in the API response so the strategy in use is never a guess. */
  strategy: string;
  /**
   * Highest score in the result set, normalised 0..1 where comparable.
   * Used to warn the model when nothing matched the question well.
   */
  topScore: number;
};

export interface Retriever {
  readonly name: string;
  retrieve(query: string, opts: RetrieveOptions): Promise<RetrievalResult>;
}

/**
 * Two documents making different claims about the same topic.
 * Detected deterministically before the model is called, so the model cannot
 * quietly pick a winner (DESIGN.md §3.5).
 */
export type Conflict = {
  topic: string;
  /** Human label for the topic, used in the prompt and the UI. */
  label: string;
  claims: ConflictClaim[];
  /** docId of the claim from the most recently effective document. */
  newerDocId: DocId;
};

export type ConflictClaim = {
  sectionId: string;
  docId: DocId;
  docTitle: string;
  effectiveDate: string;
  version: string;
  /** The value as written, e.g. "2.5%". */
  value: string;
  /** Surrounding sentence, so the scope qualifier ("before possession") survives. */
  context: string;
};

export type AnswerStatus =
  | "answered"
  | "conflict"
  | "unconfirmed"
  | "policy_refusal"
  | "not_in_documents";

export type Citation = {
  sectionId: string;
  documentTitle: string;
  heading: string;
  quote: string;
};

export type Answer = {
  status: AnswerStatus;
  answer: string;
  citations: Citation[];
  caveats: string[];
  escalateTo: string | null;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};
