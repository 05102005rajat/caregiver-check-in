import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarizeCall } from "@/lib/claude";
import { notifyFamilyContacts } from "@/lib/notify";
import { scanForConcernKeywords } from "@/lib/safety";
import { medsAtLocalTime } from "@/lib/schedule";
import { isAlreadyProcessed } from "@/lib/webhook-utils";
import type { Appointment, Call, EscalationRules, Medication, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

// Vapi endedReason values that mean the call never actually connected to a person.
const NO_ANSWER_REASONS = new Set(["customer-did-not-answer", "customer-busy", "voicemail", "no-answer"]);

const DEFAULT_CONCERN_KEYWORDS = ["fall", "fell", "dizzy", "pain", "chest", "breath", "confused", "scared"];

// Only validates the fields this route actually reads — Vapi's full event payload has
// many more fields we don't touch, so this isn't a complete schema of their API.
const webhookMessageSchema = z.object({
  type: z.string(),
  call: z
    .object({
      id: z.string().optional(),
      metadata: z.object({ internal_call_id: z.string().optional() }).partial().optional(),
    })
    .optional(),
  endedReason: z.string().optional(),
  transcript: z.string().optional(),
  artifact: z.object({ transcript: z.string().optional() }).partial().optional(),
});

export async function POST(request: Request) {
  const secretHeader = request.headers.get("x-webhook-secret");
  if (secretHeader !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json();
  const parsedMessage = webhookMessageSchema.safeParse(payload.message ?? payload);
  if (!parsedMessage.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsedMessage.error.flatten() }, { status: 400 });
  }
  const message = parsedMessage.data;

  // Consent is handled by a dedicated route (app/api/vapi/consent) — the record_consent
  // Tool is a Vapi "API Request" tool, which calls a URL you specify directly with a body
  // it builds, rather than sending an event here in this route's message envelope.

  if (message.type !== "end-of-call-report") {
    return NextResponse.json({ ok: true }); // not the event we act on
  }

  const vapiCallId = message.call?.id;
  const endedReason = message.endedReason ?? "";
  const transcript = message.artifact?.transcript ?? message.transcript ?? "";

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
    const internalCallId = message.call?.metadata?.internal_call_id;
    if (internalCallId) {
      const { data } = await db.from("calls").select("*").eq("id", internalCallId).single();
      if (data) {
        call = data as Call;
        const { error } = await db
          .from("calls")
          .update({ vapi_call_id: vapiCallId })
          .eq("id", call.id)
          .is("vapi_call_id", null);
        if (error) console.error(`Failed to backfill vapi_call_id for recovered call ${call.id}`, error);
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
    const { error } = await db.from("calls").update({ status: "no_answer" }).eq("id", call.id);
    if (error) console.error(`Failed to mark call ${call.id} no_answer`, error);
    // The next cron tick retries (or, once retries are exhausted, sends the miss-alert SMS).
    return NextResponse.json({ ok: true });
  }

  // An empty transcript almost always means the call didn't actually happen as a real
  // conversation (a pipeline error, dead air, transcription failure) even though
  // endedReason wasn't one we recognize as no-answer. Route it through the same
  // retry/miss-alert pipeline instead of silently recording it as a "completed" check-in
  // with nothing to show for it — empty transcript is not the same as a healthy call.
  const targetStatus = transcript.trim() ? "completed" : "no_answer";

  // Atomic claim before doing any paid-API work: Vapi can redeliver the same event (e.g.
  // our response was lost in transit). isAlreadyProcessed above is a plain read, so two
  // concurrent deliveries could both pass it and both call Claude + send a duplicate SMS.
  // This conditional update only succeeds for whichever request gets there first.
  const { data: claimed } = await db
    .from("calls")
    .update({ status: targetStatus })
    .eq("id", call.id)
    .eq("status", call.status)
    .select()
    .maybeSingle();
  if (!claimed) {
    return NextResponse.json({ ok: true }); // lost the race to a concurrent delivery
  }
  if (targetStatus === "no_answer") {
    return NextResponse.json({ ok: true });
  }

  const [{ data: rulesRow }, { data: parentRow }, { data: medsRow }, { data: apptsRow }] = await Promise.all([
    db.from("escalation_rules").select("*").eq("parent_id", call.parent_id).single(),
    db.from("parents").select("*").eq("id", call.parent_id).single(),
    db.from("medications").select("*").eq("parent_id", call.parent_id).eq("active", true),
    db.from("appointments").select("*").eq("parent_id", call.parent_id),
  ]);
  const parent = parentRow as Parent | null;
  const parentName = parent?.name ?? "your family member";
  const concernKeywords = (rulesRow as EscalationRules | null)?.concern_keywords ?? DEFAULT_CONCERN_KEYWORDS;

  // Meds this specific call was actually for, so Claude's med-name output can be checked
  // against reality rather than trusted outright (see isKnownMed below). Prefer the
  // snapshot taken when the call was created (immune to later medication edits); fall
  // back to reconstructing from current medications only for calls predating that column.
  const knownMedNames = (
    call.scheduled_meds ??
    (parent ? medsAtLocalTime((medsRow ?? []) as Medication[], new Date(call.scheduled_for), parent.timezone).map((m) => m.name) : [])
  ).map((n) => n.toLowerCase());
  const knownApptTitles = ((apptsRow ?? []) as Appointment[]).map((a) => a.title.toLowerCase());

  // Fuzzy substring match, but only above a minimum length — otherwise a short known name
  // (e.g. "met") would trivially "match" almost anything Claude says (e.g. "metformin").
  const fuzzyIncludes = (knownList: string[], name: string) => {
    const lower = name.toLowerCase();
    if (lower.length < 4) return knownList.includes(lower);
    return knownList.some((known) => known.length >= 4 && (known.includes(lower) || lower.includes(known)));
  };
  const isKnownMed = (name: string) => fuzzyIncludes(knownMedNames, name);
  const isKnownAppt = (title: string) => fuzzyIncludes(knownApptTitles, title);

  // Deterministic backstop, run independent of whether Claude succeeds: catches an
  // emergency mention even if the LLM call fails or under-classifies the transcript.
  const keywordMatches = scanForConcernKeywords(transcript, concernKeywords);

  let extracted;
  try {
    extracted = await summarizeCall(transcript);
  } catch (err) {
    console.error("Claude summarization failed", err);
    const { error } = await db
      .from("calls")
      .update({ status: "completed", transcript, concerns: keywordMatches })
      .eq("id", call.id);
    if (error) console.error(`Failed to record Claude-failure fallback for call ${call.id}`, error);

    if (keywordMatches.length > 0) {
      const body = `Heads up: we couldn't fully process ${parentName}'s check-in call, but noticed possible concern words (${keywordMatches.join(", ")}). Please check in with them directly.`;
      await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, body);
    }
    return NextResponse.json({ ok: true });
  }

  // Claude is asked to pick medication names out of free-form speech, which it can get
  // wrong or invent. Only keep names that plausibly match this call's actual medications;
  // anything else is dropped from the stored/notified result rather than trusted outright.
  // Always filter, even when knownMedNames is empty (e.g. an appointment-only call, whose
  // scheduled_meds snapshot is deliberately []) — an empty known-list must mean "nothing
  // Claude says here can be verified, drop it all", never "trust it unfiltered". The old
  // fallback-to-unfiltered special case only made sense for legacy calls predating the
  // scheduled_meds snapshot, but a bare length check couldn't tell "unknown" apart from
  // "deliberately none", and silently let hallucinated missed-medication alerts through
  // for calls that were never about medications at all.
  let medsConfirmed = extracted.meds_confirmed.filter(isKnownMed);
  const medsMissed = extracted.meds_missed.filter(isKnownMed);
  // If Claude contradicts itself and lists the same med as both confirmed and missed,
  // treat it as missed — matching the prompt's own "if in doubt, count as missed" stance.
  const missedLower = new Set(medsMissed.map((m) => m.toLowerCase()));
  medsConfirmed = medsConfirmed.filter((m) => !missedLower.has(m.toLowerCase()));

  const appointmentsAcknowledged = extracted.appointments_acknowledged.filter(isKnownAppt);

  if (medsConfirmed.length !== extracted.meds_confirmed.length || medsMissed.length !== extracted.meds_missed.length) {
    console.warn(`Claude returned medication name(s) not matching call ${call.id}'s actual medications; dropped`);
  }

  const concerns = Array.from(new Set([...extracted.concerns, ...keywordMatches]));

  const { error: finalUpdateError } = await db
    .from("calls")
    .update({
      status: "completed",
      transcript,
      summary: extracted.summary,
      meds_confirmed: { confirmed: medsConfirmed, missed: medsMissed, appointments_acknowledged: appointmentsAcknowledged },
      concerns,
    })
    .eq("id", call.id);
  if (finalUpdateError) console.error(`Failed to record analysis for call ${call.id}`, finalUpdateError);

  // "unknown" means Claude gave no real signal on mood (see lib/claude.ts normalize) —
  // treated as worth a look, same as an explicit "concerning," rather than silently
  // passing as fine.
  const hasConcern =
    concerns.length > 0 || extracted.mood === "concerning" || extracted.mood === "unknown" || medsMissed.length > 0;

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
