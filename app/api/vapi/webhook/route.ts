import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarizeCall } from "@/lib/claude";
import { notifyFamilyContacts } from "@/lib/notify";
import { scanForConcernKeywords } from "@/lib/safety";
import { isAlreadyProcessed } from "@/lib/webhook-utils";
import type { Call, EscalationRules, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

// Vapi endedReason values that mean the call never actually connected to a person.
const NO_ANSWER_REASONS = new Set(["customer-did-not-answer", "customer-busy", "voicemail", "no-answer"]);

const DEFAULT_CONCERN_KEYWORDS = ["fall", "fell", "dizzy", "pain", "chest", "breath", "confused", "scared"];

export async function POST(request: Request) {
  const secretHeader = request.headers.get("x-webhook-secret");
  if (secretHeader !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json();
  const message = payload.message ?? payload;

  // Consent is handled by a dedicated route (app/api/vapi/consent) — the record_consent
  // Tool is a Vapi "API Request" tool, which calls a URL you specify directly with a body
  // it builds, rather than sending an event here in this route's message envelope.

  if (message.type !== "end-of-call-report") {
    return NextResponse.json({ ok: true }); // not the event we act on
  }

  const vapiCallId: string | undefined = message.call?.id;
  const endedReason: string = message.endedReason ?? "";
  const transcript: string = message.artifact?.transcript ?? message.transcript ?? "";

  if (!vapiCallId) {
    return NextResponse.json({ error: "Missing call id" }, { status: 400 });
  }

  const db = createAdminClient();
  const { data: callRow } = await db.from("calls").select("*").eq("vapi_call_id", vapiCallId).single();
  if (!callRow) {
    console.error(`No calls row for vapi_call_id ${vapiCallId}`);
    return NextResponse.json({ ok: true });
  }
  const call = callRow as Call;

  // Webhook providers can redeliver the same event (e.g. if our response was lost in
  // transit). A completed/failed call was already fully processed — reprocessing would
  // call Claude again and could send a duplicate concern/miss-alert SMS to family.
  if (isAlreadyProcessed(call.status)) {
    return NextResponse.json({ ok: true });
  }

  if (NO_ANSWER_REASONS.has(endedReason)) {
    await db.from("calls").update({ status: "no_answer" }).eq("id", call.id);
    // The next cron tick retries (or, once retries are exhausted, sends the miss-alert SMS).
    return NextResponse.json({ ok: true });
  }

  const { data: rulesRow } = await db
    .from("escalation_rules")
    .select("*")
    .eq("parent_id", call.parent_id)
    .single();
  const concernKeywords = (rulesRow as EscalationRules | null)?.concern_keywords ?? DEFAULT_CONCERN_KEYWORDS;

  // Deterministic backstop, run independent of whether Claude succeeds: catches an
  // emergency mention even if the LLM call fails or under-classifies the transcript.
  const keywordMatches = scanForConcernKeywords(transcript, concernKeywords);

  let extracted;
  try {
    extracted = await summarizeCall(transcript);
  } catch (err) {
    console.error("Claude summarization failed", err);
    await db.from("calls").update({ status: "completed", transcript, concerns: keywordMatches }).eq("id", call.id);

    if (keywordMatches.length > 0) {
      const { data: parentRow } = await db.from("parents").select("*").eq("id", call.parent_id).single();
      const parentName = (parentRow as Parent | null)?.name ?? "your family member";
      const body = `Heads up: we couldn't fully process ${parentName}'s check-in call, but noticed possible concern words (${keywordMatches.join(", ")}). Please check in with them directly.`;
      await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, body);
    }
    return NextResponse.json({ ok: true });
  }

  const concerns = Array.from(new Set([...extracted.concerns, ...keywordMatches]));

  await db
    .from("calls")
    .update({
      status: "completed",
      transcript,
      summary: extracted.summary,
      meds_confirmed: { confirmed: extracted.meds_confirmed, missed: extracted.meds_missed },
      concerns,
    })
    .eq("id", call.id);

  const hasConcern = concerns.length > 0 || extracted.mood === "concerning" || extracted.meds_missed.length > 0;

  if (hasConcern) {
    const { data: parentRow } = await db.from("parents").select("*").eq("id", call.parent_id).single();
    const parentName = (parentRow as Parent | null)?.name ?? "your family member";

    const lines = [`Heads up from ${parentName}'s check-in: ${extracted.summary}`];
    if (extracted.meds_missed.length > 0) {
      lines.push(`Not confirmed taken: ${extracted.meds_missed.join(", ")}.`);
    }
    if (concerns.length > 0) {
      lines.push(`Concerns noted: ${concerns.join(", ")}.`);
    }

    await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, lines.join(" "));
  }
  // Healthy call, no concerns: log silently, no text. No news is good news (spec section 7).

  return NextResponse.json({ ok: true });
}
