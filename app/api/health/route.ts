import { NextResponse } from "next/server";
import { poolStatus } from "@/lib/gemini/keyPool";
import { rateLimitConfig } from "@/lib/rateLimit";
import { activeRetrieverName } from "@/lib/retrieval";
import { CORPUS } from "@/lib/corpus.generated";
import { ALL_CONFLICTS } from "@/lib/conflicts";

export const runtime = "nodejs";

/**
 * Pool and corpus state at a glance.
 *
 * Exists so that "is it the key pool or the model?" is a one-second question
 * during a demo instead of a log-reading exercise. Exposes no key material:
 * keys are labelled by index and last four characters only.
 */
export async function GET() {
  const pool = poolStatus();
  return NextResponse.json({
    ok: true,
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    mode: pool.keysConfigured > 0 ? "gemini" : "offline",
    // The strategy actually running, resolved in lib/retrieval/index.ts. Not the
    // requested env value: reporting a setting the app ignores is worse than
    // reporting nothing.
    retriever: activeRetrieverName(),
    rateLimit: rateLimitConfig(),
    corpus: { sections: CORPUS.length },
    conflicts: ALL_CONFLICTS.map((c) => ({
      topic: c.topic,
      values: c.claims.map((x) => x.value),
    })),
    keyPool: pool,
  });
}
