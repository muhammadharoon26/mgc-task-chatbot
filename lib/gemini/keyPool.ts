/**
 * Multi-key rotation pool for the Gemini API.
 *
 * ── The thing to know before reading this file ──────────────────────────────
 * Google's docs state: "Rate limits are applied per project, not per API key."
 *   https://ai.google.dev/gemini-api/docs/rate-limits
 *
 * So N keys generated inside ONE Google Cloud project share ONE quota bucket and
 * will 429 together. For rotation to buy throughput, each key must come from a
 * SEPARATE project. Configured that way, this pool multiplies quota. Configured
 * with sibling keys it still buys three real things — failover when a key is
 * revoked, clean backpressure instead of a stack trace, and zero-downtime key
 * replacement — but not throughput. The README says this too, because it is the
 * difference between a rotation layer that works and one that looks like it does.
 *
 * State lives in module memory, which on Vercel means per function instance.
 * See DESIGN.md §4.6 for why that is accepted here and what replaces it
 * (shared cooldowns in Vercel KV) when concurrency makes it matter.
 */
import { GoogleGenAI } from "@google/genai";

/** Max wait when every key is cooling down before we give up on the request. */
const MAX_WAIT_FOR_COOLDOWN_MS = 5_000;
/** Ceiling on a single key's backoff. */
const MAX_COOLDOWN_MS = 60_000;
/** Short cooldown for transient upstream problems, which usually clear fast. */
const TRANSIENT_COOLDOWN_MS = 2_000;
/** Distinct keys to try before failing the request. */
const MAX_ATTEMPTS = 4;

type KeyState = {
  index: number;
  /** "key#2 (…a3f9)" — index plus last 4 chars. Never the key itself. */
  label: string;
  client: GoogleGenAI;
  inFlight: number;
  /** Epoch ms; 0 means available now. */
  cooldownUntil: number;
  consecutiveFailures: number;
  /** Set permanently on an auth failure. A revoked key never recovers on its own. */
  disabled: boolean;
  totalCalls: number;
  totalFailures: number;
};

export class AllKeysExhaustedError extends Error {
  constructor(
    message: string,
    /** Seconds until the soonest key frees up, for the "retry in Ns" message. */
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "AllKeysExhaustedError";
  }
}

/** A caller-visible bug: no other key will like a malformed request any better. */
export class NonRetryableApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NonRetryableApiError";
  }
}

/**
 * Reads GEMINI_API_KEYS (comma-separated) and GEMINI_API_KEY_1..N.
 * Both forms exist because one env var is tidier locally, while Vercel's
 * dashboard is easier to manage with separate variables.
 */
function loadKeys(): string[] {
  const keys: string[] = [];

  const csv = process.env.GEMINI_API_KEYS ?? "";
  for (const part of csv.split(",")) {
    const trimmed = part.trim();
    if (trimmed) keys.push(trimmed);
  }

  // Single-key form, and numbered form for the Vercel dashboard.
  const single = process.env.GEMINI_API_KEY?.trim();
  if (single) keys.push(single);
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`]?.trim();
    if (k) keys.push(k);
  }

  return [...new Set(keys)];
}

function labelFor(index: number, key: string): string {
  return `key#${index + 1} (…${key.slice(-4)})`;
}

const states: KeyState[] = loadKeys().map((key, index) => ({
  index,
  label: labelFor(index, key),
  client: new GoogleGenAI({ apiKey: key }),
  inFlight: 0,
  cooldownUntil: 0,
  consecutiveFailures: 0,
  disabled: false,
  totalCalls: 0,
  totalFailures: 0,
}));

/** Round-robin cursor, used only to break ties between equally loaded keys. */
let cursor = 0;

export function isConfigured(): boolean {
  return states.length > 0;
}

/**
 * Least-loaded among eligible keys, round-robin as tiebreak.
 *
 * Plain round-robin is wrong here: a slow in-flight call would keep receiving
 * new work in its turn. Preferring the lowest `inFlight` spreads concurrent
 * requests properly, and the cursor keeps distribution even when everything is
 * idle (the common case), so calls don't all pile onto key#1.
 */
function selectKey(now: number, exclude: Set<number>): KeyState | null {
  const eligible = states.filter(
    (s) => !s.disabled && s.cooldownUntil <= now && !exclude.has(s.index),
  );
  if (eligible.length === 0) return null;

  const minInFlight = Math.min(...eligible.map((s) => s.inFlight));
  const leastLoaded = eligible.filter((s) => s.inFlight === minInFlight);

  // Advance the cursor into the least-loaded set.
  for (let i = 0; i < states.length; i++) {
    const candidate = leastLoaded.find(
      (s) => s.index === (cursor + i) % states.length,
    );
    if (candidate) {
      cursor = (candidate.index + 1) % states.length;
      return candidate;
    }
  }
  return leastLoaded[0];
}

type Classification =
  | { kind: "rate_limited"; cooldownMs: number }
  | { kind: "dead_key" }
  | { kind: "transient" }
  | { kind: "non_retryable"; status: number };

/**
 * Classify a failure. This is the part that makes rotation useful rather than
 * decorative: a pool that retries everything turns one malformed request into
 * N wasted calls and an error message that blames quota.
 */
function classify(err: unknown, state: KeyState): Classification {
  const status = extractStatus(err);
  const message = err instanceof Error ? err.message : String(err);

  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) {
    // Prefer the server's own RetryInfo when it sends one — it knows when the
    // window resets and we are only guessing.
    const serverDelay = extractRetryDelayMs(err, message);
    const backoff =
      serverDelay ??
      Math.min(MAX_COOLDOWN_MS, 2 ** state.consecutiveFailures * 1_000);
    // ±20% jitter so several instances backing off together don't retry in lockstep.
    const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4));
    return { kind: "rate_limited", cooldownMs: jittered };
  }

  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)
  ) {
    return { kind: "dead_key" };
  }

  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /UNAVAILABLE|INTERNAL|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(message)
  ) {
    return { kind: "transient" };
  }

  // 400 and friends: a schema the model rejected, an unknown model id, a
  // malformed request. Rotating cannot help and hides the real bug.
  return { kind: "non_retryable", status: status ?? 0 };
}

function extractStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as Record<string, unknown>;
  for (const field of ["status", "code", "statusCode"]) {
    const v = e[field];
    if (typeof v === "number" && v >= 100 && v < 600) return v;
  }
  const nested = e.error as Record<string, unknown> | undefined;
  if (nested && typeof nested.code === "number") return nested.code;
  // Some transports only put the code in the message: "got status: 429 ...".
  const message = err instanceof Error ? err.message : "";
  const m = /\b(4\d\d|5\d\d)\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/** Google returns RetryInfo as e.g. `"retryDelay": "17s"` inside the error body. */
function extractRetryDelayMs(err: unknown, message: string): number | null {
  const haystack =
    message + (typeof err === "object" && err ? JSON.stringify(err) : "");
  const m = /"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i.exec(haystack);
  if (!m) return null;
  return Math.min(MAX_COOLDOWN_MS, Math.round(Number(m[1]) * 1_000));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RotationOutcome<T> = {
  value: T;
  /** Which key served the call — surfaced as a response header so rotation is visible. */
  keyLabel: string;
  /** How many keys were tried before this one succeeded. Surfaced in the chat response. */
  attempts: number;
};

/**
 * Run `fn` against a pooled client, rotating on retryable failures.
 *
 * `fn` receives a client, not a key — nothing outside this module ever holds
 * key material.
 */
export async function callWithRotation<T>(
  fn: (client: GoogleGenAI) => Promise<T>,
): Promise<RotationOutcome<T>> {
  if (states.length === 0) {
    throw new AllKeysExhaustedError("No Gemini API keys configured.", 0);
  }

  const tried = new Set<number>();
  let attempts = 0;
  let lastError: unknown = null;

  while (attempts < Math.min(MAX_ATTEMPTS, states.length)) {
    let state = selectKey(Date.now(), tried);

    // Everything eligible is cooling down. Wait for the soonest one rather than
    // failing immediately — a 429 with a 2s window shouldn't surface as an error.
    if (!state) {
      const waiting = states.filter((s) => !s.disabled && !tried.has(s.index));
      if (waiting.length === 0) break;

      const soonest = Math.min(...waiting.map((s) => s.cooldownUntil));
      const waitMs = soonest - Date.now();
      if (waitMs > MAX_WAIT_FOR_COOLDOWN_MS) {
        throw new AllKeysExhaustedError(
          "All Gemini API keys are rate limited.",
          Math.ceil(waitMs / 1000),
        );
      }
      await sleep(Math.max(0, waitMs) + 50);
      state = selectKey(Date.now(), tried);
      if (!state) break;
    }

    tried.add(state.index);
    attempts++;
    state.inFlight++;
    state.totalCalls++;

    try {
      const value = await fn(state.client);
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      return {
        value,
        keyLabel: state.label,
        attempts,
      };
    } catch (err) {
      lastError = err;
      state.totalFailures++;
      state.consecutiveFailures++;
      const verdict = classify(err, state);

      switch (verdict.kind) {
        case "rate_limited":
          state.cooldownUntil = Date.now() + verdict.cooldownMs;
          console.warn(
            `[keypool] ${state.label} rate limited → cooldown ${verdict.cooldownMs}ms, rotating`,
          );
          break;
        case "dead_key":
          state.disabled = true;
          console.error(
            `[keypool] ${state.label} rejected as invalid → disabled for this instance`,
          );
          break;
        case "transient":
          state.cooldownUntil = Date.now() + TRANSIENT_COOLDOWN_MS;
          console.warn(`[keypool] ${state.label} transient failure → rotating`);
          break;
        case "non_retryable":
          // Our bug. Fail loudly instead of burning the pool on it.
          throw new NonRetryableApiError(
            err instanceof Error ? err.message : String(err),
            verdict.status,
          );
      }
    } finally {
      state.inFlight--;
    }
  }

  const soonest = Math.min(
    ...states.filter((s) => !s.disabled).map((s) => s.cooldownUntil),
  );
  const retryAfter = Number.isFinite(soonest)
    ? Math.max(0, Math.ceil((soonest - Date.now()) / 1000))
    : 0;

  throw new AllKeysExhaustedError(
    `All Gemini API keys failed after ${attempts} attempt(s). ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    retryAfter,
  );
}

/** Pool state for GET /api/health. Deliberately exposes no key material. */
export function poolStatus() {
  const now = Date.now();
  return {
    keysConfigured: states.length,
    available: states.filter((s) => !s.disabled && s.cooldownUntil <= now).length,
    coolingDown: states.filter((s) => !s.disabled && s.cooldownUntil > now).length,
    disabled: states.filter((s) => s.disabled).length,
    keys: states.map((s) => ({
      label: s.label,
      state: s.disabled
        ? ("disabled" as const)
        : s.cooldownUntil > now
          ? ("cooling" as const)
          : ("available" as const),
      cooldownMsRemaining: Math.max(0, s.cooldownUntil - now),
      totalCalls: s.totalCalls,
      totalFailures: s.totalFailures,
    })),
  };
}
