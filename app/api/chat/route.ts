import { NextResponse } from "next/server";
import { ask, MAX_HISTORY_MESSAGES } from "@/lib/answer";
import { AllKeysExhaustedError, NonRetryableApiError } from "@/lib/gemini/keyPool";
import { callerId, checkRateLimit } from "@/lib/rateLimit";
import type { ChatTurn } from "@/lib/types";

/** Node runtime: the key pool keeps per-instance state and the SDK expects Node. */
export const runtime = "nodejs";

export async function POST(request: Request) {
  // Rate limit first, before any parsing. This endpoint is unauthenticated and
  // every request sends the full corpus to Gemini, so an unthrottled loop drains
  // the API quota. See lib/rateLimit.ts for the per-instance caveat.
  const limit = checkRateLimit(callerId(request));
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "too_many_requests",
        message: `Too many requests. Try again in ${limit.retryAfterSeconds}s.`,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: { message?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  // Trimmed to the same number of messages that ask() will actually replay into
  // the prompt, so the cap here and the cap there cannot drift apart.
  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (t): t is ChatTurn =>
            typeof t === "object" &&
            t !== null &&
            (t as ChatTurn).role !== undefined &&
            typeof (t as ChatTurn).content === "string",
        )
        .slice(-MAX_HISTORY_MESSAGES)
    : [];

  try {
    const result = await ask(message, history);
    return NextResponse.json(result, {
      headers: {
        // Makes key rotation visible in the browser's network tab. Index only.
        ...(result.meta.keyLabel ? { "x-gemini-key": result.meta.keyLabel } : {}),
        "x-ratelimit-remaining": String(limit.remaining),
      },
    });
  } catch (err) {
    if (err instanceof AllKeysExhaustedError) {
      // Backpressure, not a crash. The UI renders this as a system message.
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `All configured Gemini keys are rate limited. Try again in ${err.retryAfterSeconds || 30}s.`,
          retryAfterSeconds: err.retryAfterSeconds,
        },
        { status: 503, headers: { "retry-after": String(err.retryAfterSeconds || 30) } },
      );
    }
    if (err instanceof NonRetryableApiError) {
      // Our bug, surfaced rather than hidden behind a retry loop.
      console.error("[chat] non-retryable API error:", err.message);
      return NextResponse.json(
        { error: "bad_request", message: err.message },
        { status: 502 },
      );
    }
    console.error("[chat] unexpected error:", err);
    return NextResponse.json(
      { error: "internal", message: "Something went wrong answering that." },
      { status: 500 },
    );
  }
}
