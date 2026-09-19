import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { describeLocalTime, isWithinCallingHours } from "@/lib/callwindow";
import { triggerVapiCall } from "@/lib/vapi";
import { consentGreeting, returningGreeting } from "@/lib/greeting";
import { formatAppointments, formatMeds, formatWatchItems } from "@/lib/format";
import { notifyFamilyContacts } from "@/lib/notify";
import { tooLateFingerprint } from "@/lib/insights";
import { formatLocalTime } from "@/lib/schedule";
import type { Appointment, Medication, Parent, WatchItem } from "@/types/db";

/** Fires the actual Vapi call and records the outcome on an already-created `calls` row. */
/** Why a dial didn't happen, when it didn't. Callers must not report success blindly. */
export type DialOutcome =
  | { dialed: true; callId: string }
  | { dialed: false; reason: "outside_calling_hours" | "provider_error" | "already_scheduled" };

/**
 * What this dial *is*, which decides who hears about it when it doesn't happen.
 *
 * "scheduled" is an obligation the product took on: the caregiver was promised a daily
 * call, so a dial that doesn't happen is a missed check-in and the family has to be told.
 * "manual" is the caregiver standing at the dashboard pressing the button — they are
 * watching the response, so the answer goes to them on screen and texting the family
 * "their check-in was missed" would be a fabricated alarm about a call that was never on
 * the schedule.
 *
 * "retry" is a re-dial of a call that already went out once. The caller owns the wording
 * there, because "didn't go out" would be false — it went out and nobody answered, and
 * saying the wrong one points the family at the wrong thing.
 *
 * Defaulted to "scheduled" deliberately: a future caller that forgets to say gets the
 * noisy-but-safe behaviour, not the silent one.
 */
export type DialPurpose = "scheduled" | "manual" | "retry";

export async function dialAndRecord(
  db: ReturnType<typeof createAdminClient>,
  callId: string,
  parent: Parent,
  caregiverName: string,
  medsDue: Medication[],
  todaysAppointments: Appointment[],
  watchItems: WatchItem[],
  purpose: DialPurpose = "scheduled",
  /** Doses from earlier calls today that were never confirmed — see lib/outstanding.ts. */
  outstandingMeds: string[] = []
): Promise<DialOutcome> {
  // Folds the consent ask into the opening line itself on a first call, instead of a
  // separate scripted greeting ("how are you feeling?") followed by a second, jarring
  // switch into the consent question — cuts one full back-and-forth out of the call.
  // The wording, and why it is worded that way, lives in lib/greeting.ts.
  // Set on BOTH branches. Passing undefined for a consented parent meant the line actually
  // spoken on ~99% of calls came from the Vapi dashboard — so lib/greeting.ts's own promise
  // ("it lives in one place, a copy drifting would mean scoring a line no one is read") was
  // false for exactly the common case: the eval suite scored returningGreeting, Vapi spoke
  // something else, and nothing could tell they had diverged. Three places described an
  // utterance no code controlled.
  const firstMessage = parent.consent_given_at
    ? returningGreeting(parent.name, parent.preferred_voice)
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
    //
    // Scoped to both active statuses, not just 'scheduled'. processRetries claims a row by
    // setting it 'in_progress' BEFORE calling here, so a 'scheduled'-only guard matched
    // nothing on that path: the row stayed in_progress, the reaper flipped it to no_answer
    // ten minutes later, the next tick retried, the dial was refused again — looping until
    // the family was texted "didn't answer after 2 tries" about calls never placed.
    // `.select()` on the guarded update, because the guard matching zero rows and the
    // guard matching a row are otherwise indistinguishable — the defect class that let a
    // consent withdrawal be ignored three times. Here it decides whether *we* are the ones
    // who closed this slot out, and therefore whether we owe anyone a message: without it,
    // an overlapping tick that already handled this row would send a second identical text.
    const { data: closed, error: closeError } = await db
      .from("calls")
      .update({ status: "failed" })
      .eq("id", callId)
      .in("status", ["scheduled", "in_progress"])
      .select("scheduled_for")
      .maybeSingle();
    // A null `closed` means two different things and only one of them is fine. No error =
    // another tick already closed this slot, so staying quiet is right. An error = the row
    // is still scheduled/in_progress and nobody has been told, which is the silent path
    // this whole branch exists to close — and the next tick will find the row and try
    // again, so the alert is delayed rather than lost. Logged either way so it is visible.
    if (closeError) {
      log.error("dial.close_out_failed", { call_id: callId, parent_id: parent.id, err: closeError });
    }

    // Tell the family. This is the whole point of the fix: refusing the window is correct,
    // but the refusal used to be terminal *and* silent — the row is left occupying
    // (parent_id, scheduled_for), so every later tick's "too late" branch hits a 23505 and
    // continues without a word. A check-in that never happened produced no call, no text
    // and nothing on the dashboard, which this product renders to a caregiver as "no news,
    // so everything is fine". Exactly the reasoning already written down for the stale
    // reaper a few lines away in the scheduler; this path simply never got it.
    if (closed && purpose === "scheduled") {
      const scheduledFor = new Date(closed.scheduled_for);
      const time = formatLocalTime(scheduledFor, parent.timezone);
      const subject = medsDue.length > 0 ? ` Their ${formatMeds(medsDue)} was scheduled.` : "";
      await notifyFamilyContacts(
        db,
        parent.id,
        "notify_on_miss",
        callId,
        `Heads up: ${parent.name}'s ${time} check-in didn't go out — it's now outside the hours we're willing to ring them, so we won't call about it. Please check in with them directly.${subject}`,
        // Shared with every other "this slot is too late" path so one missed slot produces
        // one text, not one per path that notices.
        { fingerprint: tooLateFingerprint(closed.scheduled_for), severity: "safety" }
      );
    }
    return { dialed: false, reason: "outside_calling_hours" };
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
        // Earlier today's unconfirmed doses, so a morning tablet that never got taken is
        // raised with the one person who can still do something about it, instead of only
        // being reported to the family and never mentioned again.
        meds_outstanding: outstandingMeds.length > 0 ? outstandingMeds.join(", ") : "none",
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
    // ...for a *scheduled* call. A manual test call has no schedule behind it, so routing
    // its provider error into the no_answer pipeline meant a caregiver pressing "Call now
    // to test" during a Vapi blip got re-dialled and eventually a "X didn't answer their
    // 3:42pm check-in after 2 tries" text about a check-in that never existed. Closed out
    // as 'failed' instead: processRetries only ever reads no_answer, so this stays out of
    // it, and the caregiver already learns it failed from the response to their click.
    log.error("dial.trigger_failed", { call_id: callId, parent_id: parent.id, purpose, err });
    const { error: providerStatusError } = await db
      .from("calls")
      .update(
        purpose === "manual"
          ? { status: "failed" }
          : { status: "no_answer", called_at: new Date().toISOString() }
      )
      .eq("id", callId);
    // If this fails the row stays scheduled/in_progress and enters neither the retry
    // pipeline nor any terminal state — the stale reaper is the only thing that will ever
    // look at it again, so the failure needs to be visible.
    if (providerStatusError) {
      log.error("dial.provider_error_status_write_failed", { call_id: callId, parent_id: parent.id, err: providerStatusError });
    }
    return { dialed: false, reason: "provider_error" };
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

  return { dialed: true, callId };
}

/** Creates a calls row for `scheduledFor` and dials, skipping if that exact slot already exists. */
export async function scheduleAndDial(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  medsForSlot: Medication[],
  todaysAppointments: Appointment[],
  scheduledFor: Date,
  watchItems: WatchItem[],
  purpose: DialPurpose = "scheduled",
  outstandingMeds: string[] = []
): Promise<DialOutcome> {
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
    // These are two different things and collapsing them told the caregiver the wrong one.
    // 23505 is the idempotency guard doing its job — a call for this slot already exists.
    // Anything else is the database failing. The test-call route reported both as "there's
    // already an active call, wait for it to finish", so during a real outage a caregiver
    // was told to wait for a call that did not exist — on the one button documented as the
    // way back out of the consent gate.
    if (insertError.code === "23505") return { dialed: false, reason: "already_scheduled" };
    console.error("Failed to create calls row", insertError);
    return { dialed: false, reason: "provider_error" };
  }
  if (!callRow) return { dialed: false, reason: "provider_error" };

  // Returns what actually happened to the *call*, not whether the row was inserted. The
  // test-call route reports success from this value, and a refused dial reported as true
  // told a caregiver "calling now" while nothing was placed.
  return dialAndRecord(db, callRow.id, parent, caregiverName, medsForSlot, todaysAppointments, watchItems, purpose, outstandingMeds);
}
