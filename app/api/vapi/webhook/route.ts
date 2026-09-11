import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarizeCall } from "@/lib/claude";
import { notifyFamilyContacts } from "@/lib/notify";
import type { Call, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

// Vapi endedReason values that mean the call never actually connected to a person.
const NO_ANSWER_REASONS = new Set(["customer-did-not-answer", "customer-busy", "voicemail", "no-answer"]);

export async function POST(request: Request) {
  const secretHeader = request.headers.get("x-webhook-secret");
  if (secretHeader !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json();
  const message = payload.message ?? payload;

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

  if (NO_ANSWER_REASONS.has(endedReason)) {
    await db.from("calls").update({ status: "no_answer" }).eq("id", call.id);
    // The next cron tick retries (or, once retries are exhausted, sends the miss-alert SMS).
    return NextResponse.json({ ok: true });
  }

  let extracted;
  try {
    extracted = await summarizeCall(transcript);
  } catch (err) {
    console.error("Claude summarization failed", err);
    await db.from("calls").update({ status: "completed", transcript }).eq("id", call.id);
    return NextResponse.json({ ok: true });
  }

  await db
    .from("calls")
    .update({
      status: "completed",
      transcript,
      summary: extracted.summary,
      meds_confirmed: { confirmed: extracted.meds_confirmed, missed: extracted.meds_missed },
      concerns: extracted.concerns,
    })
    .eq("id", call.id);

  const hasConcern =
    extracted.concerns.length > 0 || extracted.mood === "concerning" || extracted.meds_missed.length > 0;

  if (hasConcern) {
    const { data: parentRow } = await db.from("parents").select("*").eq("id", call.parent_id).single();
    const parentName = (parentRow as Parent | null)?.name ?? "your family member";

    const lines = [`Heads up from ${parentName}'s check-in: ${extracted.summary}`];
    if (extracted.meds_missed.length > 0) {
      lines.push(`Not confirmed taken: ${extracted.meds_missed.join(", ")}.`);
    }
    if (extracted.concerns.length > 0) {
      lines.push(`Concerns noted: ${extracted.concerns.join(", ")}.`);
    }

    await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, lines.join(" "));
  }
  // Healthy call, no concerns: log silently, no text. No news is good news (spec section 7).

  return NextResponse.json({ ok: true });
}
