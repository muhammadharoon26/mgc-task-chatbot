import { NextResponse } from "next/server";
import { MODEL_META, scoreLead, type LeadInput } from "@/lib/score";

export const runtime = "nodejs";

/**
 * GET returns the model card — what it was trained on and how well it does —
 * so the honest number travels with the endpoint rather than living only in a
 * README nobody opens.
 */
export async function GET() {
  return NextResponse.json({
    model: "logistic regression (intake-only features)",
    ...MODEL_META,
    note:
      "Scored on intake features only. Post-contact engagement columns " +
      "(calls, site visits, WhatsApp replies, response time) are deliberately " +
      "excluded — they are all zero when a fresh lead needs prioritising. " +
      "token_amount_received_pkr is excluded as a target leak.",
  });
}

export async function POST(request: Request) {
  let body: LeadInput;
  try {
    body = (await request.json()) as LeadInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    return NextResponse.json(scoreLead(body));
  } catch (err) {
    console.error("[score]", err);
    return NextResponse.json({ error: "Could not score that lead." }, { status: 500 });
  }
}
