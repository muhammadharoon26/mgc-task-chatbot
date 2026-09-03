/**
 * Per-caller rate limiting for the chat endpoint.
 *
 * Why this exists: /api/chat is unauthenticated and every request sends the full
 * 22-section corpus to Gemini. Without a limit, anyone who can reach a deployed
 * instance can drain the API quota in a loop.
 *
 * Fixed-window counter: count requests per caller per minute, reset when the
 * window rolls over. Chosen over a token bucket because it is ~30 lines, has no
 * dependency, and the failure mode (a caller getting up to 2x the limit across a
 * window boundary) does not matter for quota protection.
 *
 * Limitation, stated plainly: counters live in module memory, so on a serverless
 * host each instance counts separately and the effective limit is
 * (limit x instances). This raises the cost of abuse without making it
 * impossible. A shared counter in Vercel KV or Upstash Redis is the real fix.
 */

const WINDOW_MS = 60_000;

/** Requests per caller per minute. Generous enough that a human demo never trips it. */
const LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20);

/** Stop the map growing without bound if many distinct callers appear. */
const MAX_TRACKED_CALLERS = 10_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Identify the caller. Behind Vercel, `x-forwarded-for` holds the real client IP
 * as the first entry; the rest are proxies. Locally the header is absent, so all
 * requests share the "local" bucket, which is correct for a dev machine.
 *
 * This is spoofable by a determined attacker setting their own header. It raises
 * the cost of casual abuse, and is not a security boundary.
 */
export function callerId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "local";
}

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export function checkRateLimit(id: string): RateLimitResult {
  const now = Date.now();

  // Cheap eviction: only when the map is oversized, and only expired entries.
  if (windows.size > MAX_TRACKED_CALLERS) {
    for (const [key, w] of windows) {
      if (w.resetAt <= now) windows.delete(key);
    }
  }

  const existing = windows.get(id);

  if (!existing || existing.resetAt <= now) {
    windows.set(id, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: LIMIT - 1 };
  }

  if (existing.count >= LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count++;
  return { allowed: true, remaining: LIMIT - existing.count };
}

/** For /api/health, so the configured limit is visible without reading the code. */
export function rateLimitConfig() {
  return { requestsPerMinute: LIMIT, windowSeconds: WINDOW_MS / 1000 };
}
