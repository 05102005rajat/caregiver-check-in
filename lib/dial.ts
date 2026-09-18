import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { describeLocalTime, isWithinCallingHours } from "@/lib/callwindow";
import { triggerVapiCall } from "@/lib/vapi";
import { consentGreeting } from "@/lib/greeting";
import { formatAppointments, formatMeds, formatWatchItems } from "@/lib/format";
import type { Appointment, Medication, Parent, WatchItem } from "@/types/db";

/** Fires the actual Vapi call and records the outcome on an already-created `calls` row. */
export async function dialAndRecord(
  db: ReturnType<typeof createAdminClient>,
  callId: string,
  parent: Parent,
  caregiverName: string,
  medsDue: Medication[],
  todaysAppointments: Appointment[],
  watchItems: WatchItem[]
) {
  // Folds the consent ask into the opening line itself on a first call, instead of a
  // separate scripted greeting ("how are you feeling?") followed by a second, jarring
  // switch into the consent question — cuts one full back-and-forth out of the call.
  // The wording, and why it is worded that way, lives in lib/greeting.ts.
  const firstMessage = parent.consent_given_at
    ? undefined
    : consentGreeting(parent.name, parent.preferred_voice, caregiverName);

  // Hard backstop on calling hours. Placed here, at the single point every dial path goes
  // through (slot loop, retries, stale reaper, manual test call), rather than in each of
  // them — three callers previously answered "is it too late to ring" three different ways
  // and the retry path had no answer at all. A caller that believes it should dial at
  // 11:40pm is wrong, and this is where that is decided.
  if (!isWithinCallingHours(new Date(), parent.timezone)) {
    log.warn("dial.outside_calling_hours", {
      call_id: callId,
      parent_id: parent.id,
      local_time: describeLocalTime(new Date(), parent.timezone),
    });
    // Terminal, not retried: by the time the window reopens this slot is many hours stale,
    // and a "did you take your 9am pill?" call at 8am tomorrow is its own kind of confusing.
    await db.from("calls").update({ status: "failed" }).eq("id", callId).eq("status", "scheduled");
    return;
  }

  // Recorded before the dial, not after. Everything else we know about a call — status,
  // called_at, vapi_call_id — is written by the single update below, which is exactly the
  // write that fails when a row gets stranded. The consent gate therefore had no durable
  // evidence in the one case it most needs it, and closing that gap through status,
  // called_at and vapi_call_id in turn each failed for the same underlying reason. See
  // migration 0027.
  const { error: attemptError } = await db
    .from("calls")
    .update({ dial_attempted_at: new Date().toISOString() })
    .eq("id", callId);
  if (attemptError) {
    log.error("dial.attempt_stamp_failed", { call_id: callId, parent_id: parent.id, err: attemptError });
  }

  let vapiCall;
  try {
    vapiCall = await triggerVapiCall({
      toNumber: parent.phone,
      firstMessage,
      variableValues: {
        // Referenced by the record_consent Tool's Static Body Field ({{parent_id}}) so the
        // consent webhook knows which parent to update without depending on Vapi's call id.
        parent_id: parent.id,
        parent_name: parent.name,
        assistant_name: parent.preferred_voice,
        meds_due: formatMeds(medsDue),
        appointments_today: formatAppointments(todaysAppointments),
        family_setup_by: caregiverName,
        // Things the family already knows about, so Rosie asks after them by name
        // ("how's the knee today?") instead of treating every mention as news.
        watch_items: formatWatchItems(watchItems),
        // Tells the assistant whether to ask the consent question this call (spec
        // section 8: ask on the first call, and any call since where it's still unset;
        // never re-ask once consent_given_at is set).
        consent_already_given: parent.consent_given_at ? "true" : "false",
      },
      // Correlation fallback: if the update below ever fails to persist vapi_call_id,
      // the webhook can still find this row via metadata.internal_call_id instead of
      // silently dropping the call's result (see app/api/vapi/webhook/route.ts).
      metadata: { internal_call_id: callId },
    });
  } catch (err) {
    // A transient Vapi-side rejection (network blip, 5xx) is not the same as "the person
    // didn't answer" — but treating it as terminal 'failed' had the same practical effect:
    // 'failed' rows are invisible to processRetries (which only ever queries status=
    // 'no_answer'), so a single transient API error either burned a retry attempt with no
    // real signal, or — on the very first dial — skipped the entire retry budget outright.
    // Routing this into the same no_answer/retry_count pipeline as a real no-answer means
    // it gets the same number of chances before genuinely giving up and alerting family.
    log.error("dial.trigger_failed", { call_id: callId, parent_id: parent.id, err });
    await db.from("calls").update({ status: "no_answer", called_at: new Date().toISOString() }).eq("id", callId);
    return;
  }

  log.info("dial.placed", { call_id: callId, parent_id: parent.id, vapi_call_id: vapiCall.id, meds: medsDue.length });

  const { error } = await db
    .from("calls")
    .update({ status: "in_progress", called_at: new Date().toISOString(), vapi_call_id: vapiCall.id })
    .eq("id", callId);
  if (error) {
    // The call was actually placed — don't mark this 'failed', that would misreport a
    // successful dial and orphan the row from the webhook's vapi_call_id lookup for no reason
    // beyond our own bookkeeping hiccup. Leave status as-is and just log for investigation.
    log.error("dial.persist_vapi_id_failed", { call_id: callId, parent_id: parent.id, vapi_call_id: vapiCall.id, err: error });
  }
}

/** Creates a calls row for `scheduledFor` and dials, skipping if that exact slot already exists. */
export async function scheduleAndDial(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  medsForSlot: Medication[],
  todaysAppointments: Appointment[],
  scheduledFor: Date,
  watchItems: WatchItem[]
): Promise<boolean> {
  // calls has a unique (parent_id, scheduled_for) constraint: this is the idempotency
  // guard against a cron tick (or an overlapping manual trigger) dialing twice for one slot.
  const { data: callRow, error: insertError } = await db
    .from("calls")
    .insert({
      parent_id: parent.id,
      scheduled_for: scheduledFor.toISOString(),
      status: "scheduled",
      // Snapshot at creation time so later analysis (and any future caregiver edits to
      // medications) can't retroactively change what this specific call was actually for.
      scheduled_meds: medsForSlot.map((m) => m.name),
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code !== "23505") console.error("Failed to create calls row", insertError);
    return false; // already scheduled this slot, or a real error either way nothing to dial
  }
  if (!callRow) return false;

  await dialAndRecord(db, callRow.id, parent, caregiverName, medsForSlot, todaysAppointments, watchItems);
  return true;
}
