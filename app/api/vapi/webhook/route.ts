import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarizeCall } from "@/lib/claude";
import { notifyFamilyContacts } from "@/lib/notify";
import { alertFingerprint } from "@/lib/insights";
import { warrantsAttention } from "@/lib/alerting";
import { log } from "@/lib/log";
import { DEFAULT_CONCERN_KEYWORDS, hasParentResponse, hasRecognisableSpeakerLabels, scanForConcernKeywords } from "@/lib/safety";
import { medsAtLocalTime } from "@/lib/schedule";
import { isAlreadyProcessed } from "@/lib/webhook-utils";
import type { Appointment, Call, EscalationRules, Medication, Parent, WatchItem } from "@/types/db";

export const dynamic = "force-dynamic";

// Vapi endedReason values that mean the call never actually connected to a person.
const NO_ANSWER_REASONS = new Set(["customer-did-not-answer", "customer-busy", "voicemail", "no-answer"]);

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
    log.error("webhook.unmatched_call", { vapi_call_id: vapiCallId, ended_reason: endedReason });
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
    log.info("webhook.duplicate_delivery_ignored", { call_id: call.id, vapi_call_id: vapiCallId });
    return NextResponse.json({ ok: true }); // lost the race to a concurrent delivery
  }
  log.info("webhook.received", { call_id: call.id, parent_id: call.parent_id, vapi_call_id: vapiCallId, status: targetStatus });
  if (targetStatus === "no_answer") {
    return NextResponse.json({ ok: true });
  }

  const [{ data: rulesRow }, { data: parentRow }, { data: medsRow }, { data: apptsRow }, { data: watchRow }] = await Promise.all([
    db.from("escalation_rules").select("*").eq("parent_id", call.parent_id).single(),
    db.from("parents").select("*").eq("id", call.parent_id).single(),
    db.from("medications").select("*").eq("parent_id", call.parent_id).eq("active", true),
    db.from("appointments").select("*").eq("parent_id", call.parent_id),
    db.from("watch_items").select("*").eq("parent_id", call.parent_id),
  ]);
  // "We could not read the parent row" is not the same as "they did not consent" — the
  // no-consent branch below cannot tell them apart and would destroy the transcript, skip
  // Claude, alert nobody, and log it as a refusal.
  let parent = parentRow as Parent | null;
  if (!parent) {
    // Retry first: a transient blip is the whole reason this branch exists, and recovering
    // here avoids every trade-off below.
    for (let attempt = 0; attempt < 2 && !parent; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      const { data } = await db.from("parents").select("*").eq("id", call.parent_id).maybeSingle();
      parent = (data as Parent | null) ?? null;
    }
    if (parent) {
      log.info("webhook.parent_lookup_recovered", { call_id: call.id, parent_id: call.parent_id });
    }
  }

  if (!parent) {
    // Do NOT release the claim back to 'scheduled'/'in_progress'. Those are *active*
    // statuses: reapStaleScheduled would re-dial this parent about a check-in that already
    // happened, and the in-progress reaper would flip it to no_answer and hand it to
    // processRetries to dial again. A transient database blip must not ring an 80-year-old
    // a second time about a call they already took — which is what the previous version of
    // this branch did.
    //
    // 'failed' is terminal and non-dialable. The transcript is lost — but we never managed
    // to establish whether consent exists, so discarding is the safe direction anyway — and
    // the row does not masquerade as a healthy check-in the way a 'completed' row with a
    // null transcript does. dial_attempted_at still records that we rang.
    const { error: markError } = await db
      .from("calls")
      .update({ status: "failed" })
      .eq("id", call.id)
      .eq("status", targetStatus);
    if (markError) {
      log.error("webhook.parent_lookup_mark_failed", { call_id: call.id, err: markError });
    }
    log.error("webhook.parent_lookup_failed", { call_id: call.id, parent_id: call.parent_id });
    return NextResponse.json({ ok: false, error: "Could not load parent" }, { status: 503 });
  }

  const parentName = parent.name;
  const concernKeywords = (rulesRow as EscalationRules | null)?.concern_keywords ?? DEFAULT_CONCERN_KEYWORDS;

  // No consent, no record.
  //
  // Consent is granted mid-call via the record_consent tool, so by the time this end-of-call
  // report arrives, a parent who agreed already has consent_given_at set. If it's still null
  // this is a call we had no permission to keep: they declined, or hung up before answering,
  // or never understood the question. Storing the transcript anyway — which is what happened
  // before — meant the words of someone who had just said "no, don't record me" were written
  // to our database regardless, which is the violation the refusal was meant to prevent, and
  // it persisted in our own system rather than only in Vapi's.
  //
  // So: keep the fact that a call happened, discard what was said, and don't send it to
  // Claude either. The caregiver has already been told about a refusal by /api/vapi/consent.
  if (!parent.consent_given_at) {
    // Not storing the words is right. Dropping the emergency backstop with them is not:
    // someone can decline recording and, in the same breath, say "I fell and I can't get
    // up". The keyword scan exists precisely so a Claude outage or misclassification can't
    // silently swallow that, and returning early here swallowed it by construction.
    //
    // So the scan runs in memory and the alert deliberately carries no quotes, no summary
    // and no detail — only that something in the call needs a human. That keeps the safety
    // promise without keeping anything we have no permission to keep.
    const urgent = scanForConcernKeywords(transcript, concernKeywords);
    if (urgent.length > 0) {
      await notifyFamilyContacts(
        db,
        call.parent_id,
        "notify_on_concern",
        call.id,
        `Please check on ${parentName} directly. Something they said during today's call may need attention. They didn't agree to us keeping a record of the call, so we haven't kept any details.`,
        { fingerprint: alertFingerprint("no-consent-urgent", [call.id]), severity: "safety" }
      );
      log.error("webhook.urgent_without_consent", { call_id: call.id, parent_id: call.parent_id, matches: urgent.length });
    }

    const { error } = await db
      .from("calls")
      .update({ status: "completed", transcript: null, summary: null })
      .eq("id", call.id);
    if (error) log.error("webhook.no_consent_discard_failed", { call_id: call.id, err: error });
    log.info("webhook.transcript_discarded_no_consent", { call_id: call.id, parent_id: call.parent_id });
    return NextResponse.json({ ok: true });
  }

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

  // Both deterministic backstops below key off speaker labels. If the provider changes
  // that format they degrade silently and in opposite directions at once — the keyword
  // scan starts reading Rosie's own words (daily false alerts) while hasParentResponse
  // reports every call as unanswered. Neither throws, so without this line the first
  // symptom would be a caregiver asking why the alerts stopped making sense.
  if (transcript.trim() && !hasRecognisableSpeakerLabels(transcript)) {
    log.error("webhook.unrecognised_transcript_format", {
      call_id: call.id,
      parent_id: call.parent_id,
      sample: transcript.slice(0, 120),
    });
  }

  // Deterministic backstop, run independent of whether Claude succeeds: catches an
  // emergency mention even if the LLM call fails or under-classifies the transcript.
  const keywordMatches = scanForConcernKeywords(transcript, concernKeywords);

  let extracted;
  try {
    // Watch items the family has already flagged as known — raises the bar for alerting
    // on those specific topics only, so a chronic complaint doesn't generate a text every
    // morning while anything new or worsening still comes straight through.
    const watchItems = (watchRow ?? []) as WatchItem[];
    const knownIssues = watchItems.filter((w) => !w.always_alert).map((w) => w.description);
    // always_alert is what the setup checkbox actually promises ("alert me every time this
    // comes up"); without passing it through, ticking it merely opted out of suppression
    // while the base prompt still declined to flag an unchanged chronic complaint.
    const alwaysReport = watchItems.filter((w) => w.always_alert).map((w) => w.description);
    extracted = await summarizeCall(transcript, knownIssues, alwaysReport);
  } catch (err) {
    log.error("webhook.summarize_failed", { call_id: call.id, parent_id: call.parent_id, err });
    const { error } = await db
      .from("calls")
      .update({ status: "completed", transcript, concerns: keywordMatches })
      .eq("id", call.id);
    if (error) console.error(`Failed to record Claude-failure fallback for call ${call.id}`, error);

    if (keywordMatches.length > 0) {
      const body = `Heads up: we couldn't fully process ${parentName}'s check-in call, but noticed possible concern words (${keywordMatches.join(", ")}). Please check in with them directly.`;
      await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, body, {
        fingerprint: alertFingerprint("keyword", keywordMatches),
        severity: "safety" as const,
      });
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

  // Structural backstop, independent of what Claude concluded: if the parent never
  // actually spoke, this was not a check-in, regardless of how the transcript reads.
  // See lib/safety.hasParentResponse — the eval set showed the model only catches this
  // about half the time, and "nobody heard from Mom" must never depend on a coin flip.
  const noResponse = !hasParentResponse(transcript) ? ["Parent didn't respond — call ended without a conversation"] : [];
  const concerns = Array.from(new Set([...extracted.concerns, ...keywordMatches, ...noResponse]));

  const { error: finalUpdateError } = await db
    .from("calls")
    .update({
      status: "completed",
      transcript,
      summary: extracted.summary,
      meds_confirmed: { confirmed: medsConfirmed, missed: medsMissed, appointments_acknowledged: appointmentsAcknowledged },
      concerns,
      requests: extracted.requests,
      mood: extracted.mood,
    })
    .eq("id", call.id);
  if (finalUpdateError) console.error(`Failed to record analysis for call ${call.id}`, finalUpdateError);

  // "unknown" means Claude gave no real signal on mood (see lib/claude.ts normalize) —
  // treated as worth a look, same as an explicit "concerning," rather than silently
  // passing as fine.
  // Shared with the dashboard and the eval scorer — see lib/alerting.ts. Three hand-kept
  // copies of this rule had already drifted apart.
  const hasConcern = warrantsAttention({ concerns, medsMissed, mood: extracted.mood });

  if (hasConcern) {
    // Bulleted and scannable rather than one long paragraph: this arrives as a text on a
    // phone, and a worried family member should be able to see what's wrong at a glance
    // instead of reading a five-line summary to find the one fact that matters.
    const lines = [`${parentName}'s check-in — needs a look:`];
    if (medsMissed.length > 0) {
      lines.push("", "Not taken:", ...medsMissed.map((m) => `• ${m}`));
    }
    if (concerns.length > 0) {
      lines.push("", "Concerns:", ...concerns.map((c) => `• ${c}`));
    }
    // Rosie promised on the call to pass these on, so they go in whether or not anything
    // else was concerning.
    if (extracted.requests.length > 0) {
      lines.push("", `${parentName} asked for:`, ...extracted.requests.map((r) => `• ${r}`));
    }

    // Fingerprint the structured facts, not the prose: Claude rewords the same situation
    // differently every call, so body text would never match and nothing would dedupe.
    await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, lines.join("\n"), {
      fingerprint: alertFingerprint("concern", [...concerns, ...medsMissed.map((m) => `missed:${m}`)]),
      // A second fall the same day is not a duplicate to collapse; a repeat pizza request is.
      severity: "safety" as const,
    });
  } else if (extracted.requests.length > 0) {
    // Nothing is wrong, but they asked for something and Rosie said she'd pass it on.
    // Staying silent here would quietly break a promise the person heard her make — and
    // "Mum would like a visit" is exactly what a family wants to hear, even on a good day.
    const lines = [`${parentName} is doing fine, and asked for:`, "", ...extracted.requests.map((r) => `• ${r}`)];
    await notifyFamilyContacts(db, call.parent_id, "notify_on_concern", call.id, lines.join("\n"), {
      fingerprint: alertFingerprint("request", extracted.requests),
      severity: "routine" as const,
    });
  }
  // Healthy call, nothing asked for: log silently, no text. No news is good news.

  return NextResponse.json({ ok: true });
}
