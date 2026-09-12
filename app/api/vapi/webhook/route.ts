import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarizeCall } from "@/lib/claude";
import { notifyFamilyContacts } from "@/lib/notify";
import { scanForConcernKeywords } from "@/lib/safety";
import { medsAtLocalTime } from "@/lib/schedule";
import { isAlreadyProcessed } from "@/lib/webhook-utils";
import type { Call, EscalationRules, Medication, Parent } from "@/types/db";

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
  let call: Call | null = null;
  {
    const { data } = await db.from("calls").select("*").eq("vapi_call_id", vapiCallId).single();
    call = data as Call | null;
  }

  if (!call) {
    // Fallback: if our own DB update right after dialing ever failed to persist
    // vapi_call_id, the row is otherwise unreachable by it. We passed our internal
    // call id as Vapi call metadata specifically to recover from that (see lib/dial.ts).
    const internalCallId: string | undefined = message.call?.metadata?.internal_call_id;
    if (internalCallId) {
      const { data } = await db.from("calls").select("*").eq("id", internalCallId).single();
      if (data) {
        call = data as Call;
        await db.from("calls").update({ vapi_call_id: vapiCallId }).eq("id", call.id).is("vapi_call_id", null);
      }
    }
  }

  if (!call) {
    console.error(`No calls row for vapi_call_id ${vapiCallId}`);
    return NextResponse.json({ ok: true });
  }

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

  // Atomic claim before doing any paid-API work: Vapi can redeliver the same event (e.g.
  // our response was lost in transit). isAlreadyProcessed above is a plain read, so two
  // concurrent deliveries could both pass it and both call Claude + send a duplicate SMS.
  // This conditional update only succeeds for whichever request gets there first.
  const { data: claimed } = await db
    .from("calls")
    .update({ status: "completed" })
    .eq("id", call.id)
    .eq("status", call.status)
    .select()
    .maybeSingle();
  if (!claimed) {
    return NextResponse.json({ ok: true }); // lost the race to a concurrent delivery
  }

  if (!transcript.trim()) {
    // Nothing for Claude to analyze (e.g. a pipeline error before any dialogue) — skip
    // the paid call entirely rather than paying for a completion with no real signal.
    return NextResponse.json({ ok: true });
  }

  const [{ data: rulesRow }, { data: parentRow }, { data: medsRow }] = await Promise.all([
    db.from("escalation_rules").select("*").eq("parent_id", call.parent_id).single(),
    db.from("parents").select("*").eq("id", call.parent_id).single(),
    db.from("medications").select("*").eq("parent_id", call.parent_id).eq("active", true),
  ]);
  const parent = parentRow as Parent | null;
  const parentName = parent?.name ?? "your family member";
  const concernKeywords = (rulesRow as EscalationRules | null)?.concern_keywords ?? DEFAULT_CONCERN_KEYWORDS;

  // Meds this specific call was actually for, so Claude's med-name output can be checked
  // against reality rather than trusted outright (see knownMedNames below).
  const medsForSlot = parent ? medsAtLocalTime((medsRow ?? []) as Medication[], new Date(call.scheduled_for), parent.timezone) : [];
  const knownMedNames = medsForSlot.map((m) => m.name.toLowerCase());
  const isKnownMed = (name: string) => {
    const lower = name.toLowerCase();
    return knownMedNames.some((known) => known.includes(lower) || lower.includes(known));
  };

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
      const body = `Heads up: we couldn't fully process ${parentName}'s check-in call, but noticed possible concern words (${keywordMatches.join(", ")}). Please check in with them directly.`;
      await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, body);
    }
    return NextResponse.json({ ok: true });
  }

  // Claude is asked to pick medication names out of free-form speech, which it can get
  // wrong or invent. Only keep names that plausibly match this call's actual medications;
  // anything else is dropped from the stored/notified result rather than trusted outright.
  const medsConfirmed = knownMedNames.length > 0 ? extracted.meds_confirmed.filter(isKnownMed) : extracted.meds_confirmed;
  const medsMissed = knownMedNames.length > 0 ? extracted.meds_missed.filter(isKnownMed) : extracted.meds_missed;
  if (medsConfirmed.length !== extracted.meds_confirmed.length || medsMissed.length !== extracted.meds_missed.length) {
    console.warn(`Claude returned medication name(s) not matching call ${call.id}'s actual medications; dropped`);
  }

  const concerns = Array.from(new Set([...extracted.concerns, ...keywordMatches]));

  await db
    .from("calls")
    .update({
      status: "completed",
      transcript,
      summary: extracted.summary,
      meds_confirmed: { confirmed: medsConfirmed, missed: medsMissed },
      concerns,
    })
    .eq("id", call.id);

  const hasConcern = concerns.length > 0 || extracted.mood === "concerning" || medsMissed.length > 0;

  if (hasConcern) {
    const lines = [`Heads up from ${parentName}'s check-in: ${extracted.summary}`];
    if (medsMissed.length > 0) {
      lines.push(`Not confirmed taken: ${medsMissed.join(", ")}.`);
    }
    if (concerns.length > 0) {
      lines.push(`Concerns noted: ${concerns.join(", ")}.`);
    }

    await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, lines.join(" "));
  }
  // Healthy call, no concerns: log silently, no text. No news is good news (spec section 7).

  return NextResponse.json({ ok: true });
}
