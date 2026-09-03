/**
 * Retriever selection.
 *
 * One place decides which retrieval strategy is active, so the app and
 * /api/health can never disagree about what is actually running.
 */
import { LexicalRetriever } from "./lexical";
import type { Retriever } from "../types";

/** Strategies that exist. Add to this list when a new implementation lands. */
const IMPLEMENTED = ["lexical"] as const;
type StrategyName = (typeof IMPLEMENTED)[number];

const DEFAULT_STRATEGY: StrategyName = "lexical";

function resolveStrategy(): StrategyName {
  const requested = process.env.RETRIEVER?.trim().toLowerCase();
  if (!requested) return DEFAULT_STRATEGY;

  if ((IMPLEMENTED as readonly string[]).includes(requested)) {
    return requested as StrategyName;
  }

  // Warn loudly rather than silently ignoring the setting. A config value the
  // app quietly disregards is worse than no config value at all.
  console.warn(
    `[retriever] RETRIEVER="${requested}" is not implemented. ` +
      `Available: ${IMPLEMENTED.join(", ")}. Falling back to "${DEFAULT_STRATEGY}".`,
  );
  return DEFAULT_STRATEGY;
}

const ACTIVE: StrategyName = resolveStrategy();

/** Built once: the index it wraps is a module-level constant, so there is nothing per-request. */
const INSTANCE: Retriever = new LexicalRetriever();

export function getRetriever(): Retriever {
  return INSTANCE;
}

/** What is really running, for /api/health. Never the requested value. */
export function activeRetrieverName(): string {
  return ACTIVE;
}
