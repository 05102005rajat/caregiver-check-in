import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dialAndRecord, scheduleAndDial } from "@/lib/dial";
import { retryDecision } from "@/lib/retry";
import { isWithinCallingHours } from "@/lib/callwindow";
import { appointmentsToday, formatLocalTime, medsAtLocalTime } from "@/lib/schedule";
import { SLOT_CATCHUP_MINUTES, medsForSlot as resolveMedsForSlot } from "@/lib/slots";
import { cancelPendingSlots, dispatchDueSlots, expireLapsedSlots, materializeSlots } from "@/lib/queue";
import { formatAppointments, formatMeds } from "@/lib/format";
import { notifyFamilyContacts } from "@/lib/notify";
import { alertFingerprint, tooLateFingerprint } from "@/lib/insights";
import { log } from "@/lib/log";
import type { Appointment, Call, EscalationRules, Medication, Parent, WatchItem } from "@/types/db";

export const dynamic = "force-dynamic";

// How long a row stranded at 'scheduled' may keep being re-dialled before we give up.
//
// An age, not a count, because that is what the code can actually measure: there is no
// redial counter, and the previous `floor(age / 10min) >= 2` was an age bound wearing a
// count's name — it allowed exactly one redial, and abandoned a row first seen after an
// overnight outage on its second pass. The failure that strands a row tends to repeat, so
// the bound exists to stop a loop that phones a real person every tick.
const STALE_REDIAL_GIVEUP_MINUTES = 30;

// How long a raw transcript is kept. The product runs on summary/mood/concerns; the
// transcript is the most sensitive thing this system holds and the least needed after the
// fact. 30 days so a caregiver reading a worrying alert a fortnight later can still see
// what was actually said.
const TRANSCRIPT_RETENTION_DAYS = 30;

/** Promise.all keyed by name, so inserting a query can't silently shift the results. */
async function allNamed<T extends Record<string, PromiseLike<unknown>>>(
  queries: T
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(queries) as Array<keyof T>;
  const settled = await Promise.all(keys.map((k) => queries[k]));
  return Object.fromEntries(keys.map((k, i) => [k, settled[i]])) as { [K in keyof T]: Awaited<T[K]> };
}

function groupByParentId<T extends { parent_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.parent_id);
    if (bucket) bucket.push(row);
    else map.set(row.parent_id, [row]);
  }
  return map;
}

/**
 * How many times we actually rang, in words.
 *
 * `max_retries` counts *retries*, so the initial call plus two retries is three attempts
 * reported as "after 2 tries" — and `max_retries: 0`, which the setup form allows, produced
 * the plainly wrong "didn't answer their 9:00am check-in after 0 tries" for a call that was
 * genuinely placed once. Whatever the family is told here, they act on it.
 */
function describeAttempts(maxRetries: number): string {
  const attempts = maxRetries + 1;
  return `${attempts} ${attempts === 1 ? "try" : "tries"}`;
}

async function processRetries(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  rules: EscalationRules,
  medications: Medication[],
  appointments: Appointment[],
  noAnswerCalls: Call[],
  now: Date,
  watchItems: WatchItem[]
) {
  for (const call of noAnswerCalls) {
    const decision = retryDecision(call, rules);
    if (decision === "wait") continue;

    // A retry that lands after the calling window is not "we never rang" — we rang, they
    // didn't answer, and we have run out of day. Deciding it here rather than letting
    // lib/dial.ts refuse it means the family gets the true sentence: dial.ts would mark the
    // row failed and text "their 8:30pm check-in didn't go out", about a call that did go
    // out, and the accurate "didn't answer" message would then never be sent because the
    // row is no longer no_answer. The chokepoint still refuses; it just isn't the thing
    // that describes a retry to a caregiver.
    const windowClosed = decision === "retry" && !isWithinCallingHours(now, parent.timezone);
    const nextStatus = decision === "exhausted" || decision === "too_late" || windowClosed ? "failed" : "in_progress";

    // Optimistic-concurrency claim: only proceeds if the row is still exactly as we
    // read it. If an overlapping cron tick already claimed it, this affects 0 rows and
    // we back off, instead of both invocations placing a duplicate retry call.
    const { data: claimed } = await db
      .from("calls")
      .update(
        nextStatus === "failed"
          ? { status: "failed" }
          : // called_at moves to now as part of the claim. Leaving the previous attempt's
            // timestamp meant the row went 'in_progress' already older than the stale
            // reaper's 10-minute threshold, so a reaper run in the window before dial()
            // writes its own called_at could flip a genuinely connecting call to
            // 'no_answer' and place a second call while the first was live.
            { status: "in_progress", retry_count: call.retry_count + 1, called_at: new Date().toISOString() }
      )
      .eq("id", call.id)
      .eq("status", "no_answer")
      .eq("retry_count", call.retry_count)
      .select()
      .maybeSingle();

    if (!claimed) continue; // lost the race to another cron invocation

    const scheduledFor = new Date(call.scheduled_for);
    const medsForSlot = call.scheduled_meds
      ? resolveMedsForSlot(medications, call.scheduled_meds, scheduledFor, parent.timezone)
      : medsAtLocalTime(medications, scheduledFor, parent.timezone);

    if (nextStatus === "failed") {
      const time = formatLocalTime(scheduledFor, parent.timezone);
      // medsForSlot is empty for an appointment-only call (a slot of kind 'appointment',
      // see lib/slots.ts) — falling back to formatMeds([]) there produced the nonsensical
      // "Their none was scheduled." Use the day's appointments instead when there's no
      // medication to report, so the alert actually names what was missed.
      const subject =
        medsForSlot.length > 0
          ? `Their ${formatMeds(medsForSlot)} was scheduled.`
          : (() => {
              const todaysAppts = appointmentsToday(appointments, parent.timezone, scheduledFor);
              return todaysAppts.length > 0 ? `Their ${formatAppointments(todaysAppts)} appointment was scheduled.` : "";
            })();
      // Two different facts, two different sentences. "Didn't answer after N tries" is a
      // statement about the parent; when we gave up because the slot went stale it is a
      // statement about us, and saying the first would be untrue and alarming in a way that
      // points the family at the wrong thing.
      const body = windowClosed
        ? `Heads up: ${parent.name} didn't answer their ${time} check-in, and it's now too late in the evening for us to try again. Please check in with them directly. ${subject}`.trim()
        : decision === "too_late"
          ? `Heads up: ${parent.name}'s ${time} check-in didn't go out — our scheduler fell behind and it's now too late to call about it. Please check in with them directly. ${subject}`.trim()
          : `Heads up: ${parent.name} didn't answer their ${time} check-in after ${describeAttempts(rules.max_retries)}. ${subject}`.trim();
      await notifyFamilyContacts(db, parent.id, "notify_on_miss", call.id, body, {
        fingerprint: alertFingerprint("miss", [call.scheduled_for]),
        severity: "safety",
      });
      continue;
    }

    const retryOutcome = await dialAndRecord(
      db,
      call.id,
      parent,
      caregiverName,
      medsForSlot,
      appointmentsToday(appointments, parent.timezone, now),
      // Without this a retry stops asking after the knee the first dial asked about —
      // Rosie's "remembering" would be inconsistent within the same morning.
      watchItems,
      // This branch owns what a refused retry says to the family (see windowClosed above).
      "retry"
    );

    // windowClosed is computed from `now`, before the optimistic claim is awaited. If the
    // window shuts inside that gap the claim path is taken, dialAndRecord refuses, and the
    // "retry" purpose deliberately keeps it quiet — so the row lands at failed with neither
    // branch having said anything. A sub-second race against a five-minute tick, but it is
    // the silent shape, so it is closed here rather than argued about.
    if (!retryOutcome.dialed && retryOutcome.reason === "outside_calling_hours") {
      const time = formatLocalTime(scheduledFor, parent.timezone);
      await notifyFamilyContacts(
        db,
        parent.id,
        "notify_on_miss",
        call.id,
        `Heads up: ${parent.name} didn't answer their ${time} check-in, and it's now too late in the evening for us to try again. Please check in with them directly.`,
        { fingerprint: alertFingerprint("miss", [call.scheduled_for]), severity: "safety" }
      );
    }
  }
}

/**
 * Whether a `calls` row corresponds to a slot the queue planned, as opposed to a manual
 * test call the caregiver started from the dashboard. The two rows are identical; only the
 * presence of a slot at that instant tells them apart.
 *
 * Fails CLOSED on a read error — "scheduled" is the noisy-but-safe answer, since the cost
 * of guessing wrong that way is a alert about a real slot rather than silence about one.
 */
async function slotFor(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  scheduledFor: string
): Promise<{ known: boolean; found: boolean; state: string | null }> {
  const { data, error } = await db
    .from("call_slots")
    .select("id, state")
    .eq("parent_id", parentId)
    .eq("due_at", scheduledFor)
    .limit(1)
    .maybeSingle();
  if (error) {
    // Neither default is safe. "scheduled" re-dials a manual test call and can text the
    // family "their 3:42pm check-in didn't go out" about a call the caregiver started from
    // the dashboard; "manual" stays quiet about a real missed obligation whose slot is
    // already dispatched and will therefore never expire. So this answers "I don't know",
    // the reaper leaves the row alone for this tick, and the degraded heartbeat surfaces
    // the read failure instead of either guess being made silently.
    log.error("cron.slot_lookup_failed", { parent_id: parentId, scheduled_for: scheduledFor, err: error });
    return { known: false, found: false, state: null };
  }
  return { known: true, found: Boolean(data), state: (data?.state as string) ?? null };
}

/**
 * A calls row can get stuck in 'scheduled' forever if dialAndRecord's post-dial DB write
 * failed right after a successful Vapi call (rare, but the row never got its vapi_call_id
 * or a called_at, so the in_progress reaper below never sees it) — or, less likely, if
 * the process crashed between the insert and the dial. Re-attempts the dial on the same
 * row rather than leaving it stranded; the active-call unique index still protects against
 * this colliding with a genuinely in-flight call for the same parent.
 */
async function reapStaleScheduled(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  medications: Medication[],
  appointments: Appointment[],
  now: Date,
  watchItems: WatchItem[]
) {
  // Same 10-minute (2x max call duration) buffer as the in_progress reaper below — a call
  // that's actually still ringing/talking can legitimately keep this row at 'scheduled'
  // for close to the full call duration if the post-dial bookkeeping write failed; a
  // shorter threshold risked re-dialing a parent mid-conversation.
  const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { data: staleRows } = await db
    .from("calls")
    .select("*")
    .eq("parent_id", parent.id)
    .eq("status", "scheduled")
    .lt("created_at", staleThreshold);

  for (const row of (staleRows ?? []) as Call[]) {
    // Respect the same catch-up window as every other dial path. Without this a row
    // stranded overnight was re-dialled the next day at whatever hour the tick ran —
    // exactly the "very-late, confusing check-in call about a medication from hours ago"
    // SLOT_CATCHUP_MINUTES exists to prevent. There is also no attempt cap here, so if the
    // post-dial write keeps failing (the very thing that strands a row) it would re-dial
    // every tick forever; closing it out after the window bounds that.
    const scheduledFor = new Date(row.scheduled_for);
    // Directional on purpose: minutesBetween is absolute, so using it here would also
    // abandon a row scheduled in the future as though it were hours late.
    const minutesLate = (now.getTime() - scheduledFor.getTime()) / 60000;
    if (minutesLate > SLOT_CATCHUP_MINUTES) {
      // Nothing to preserve here any more: dial_attempted_at (migration 0027) was written
      // before the dial and survives whatever happened after, so closing the row out can no
      // longer erase the consent gate's evidence. The previous attempt to preserve it —
      // stamping called_at when vapi_call_id proved a dial — was dead code: vapi_call_id is
      // written by the very update whose failure strands the row, so it is always null here.
      const { error } = await db
        .from("calls")
        .update({ status: "failed" })
        .eq("id", row.id)
        .eq("status", "scheduled");
      if (error) {
        // Don't log success after a failure: the row stays 'scheduled' and is re-abandoned
        // every tick, and a cheerful "abandoned" line each time hides that it never worked.
        log.error("cron.abandon_stale_scheduled_failed", { call_id: row.id, err: error });
        continue;
      }
      log.info("cron.abandoned_stale_scheduled", { call_id: row.id, parent_id: parent.id, scheduled_for: row.scheduled_for });

      // Tell the family. The row still occupies (parent_id, scheduled_for), so the slot
      // loop's own "too late to call" branch hits a 23505 and continues silently — meaning
      // a check-in that never happened would otherwise produce no call, no text and no
      // record anywhere that it was missed. Previously the row was re-dialled, so at worst
      // the parent got a late call; abandoning it without this is strictly quieter.
      // Gated like the give-up and redial branches below. Without it, a caregiver whose
      // manual test call at 15:42 stranded gets the family texted "we couldn't complete
      // their check-in around 3:42pm" about a call that was never on the schedule — the
      // fabricated alarm the "manual" purpose exists to prevent, arriving by another door.
      const abandonSlot = await slotFor(db, parent.id, row.scheduled_for);
      if (!abandonSlot.known || !abandonSlot.found) {
        log.info("cron.abandon_alert_skipped", {
          call_id: row.id,
          parent_id: parent.id,
          reason: abandonSlot.known ? "no_slot_manual_call" : "slot_unknown",
        });
        continue;
      }
      const time = formatLocalTime(scheduledFor, parent.timezone);
      await notifyFamilyContacts(
        db,
        parent.id,
        "notify_on_miss",
        row.id,
        `Heads up: we couldn't complete ${parent.name}'s check-in around ${time}, and it's now too late to call about it. Please check in with them directly.`,
        // Normalised: the slot loop's too-late branch fingerprints scheduledFor.toISOString()
        // ("…T16:00:00.000Z") while Postgres hands back "…T16:00:00+00:00". Same slot, same
        // alert kind, different string — so the two paths would not dedupe against each other.
        // severity 'safety' like every other path sharing this fingerprint. Without it this
        // one alert got the 20-hour routine window instead of 4, so it deduped against a
        // different span of time than the branches it is supposed to agree with.
        { fingerprint: tooLateFingerprint(row.scheduled_for), severity: "safety" }
      );
      continue;
    }
    // Bounded. The condition that strands a row — the post-dial write failing — is exactly
    // the condition that recurs, so with a 5-minute tick and a 2-hour catch-up window this
    // loop could place ~22 real phone calls to the same person. The comment above used to
    // argue SLOT_CATCHUP_MINUTES bounded it; it bounds the duration, not the count.
    //
    // Claimed on stale_redial_at (migration 0032) — not retry_count, and no longer
    // called_at. retry_count is processRetries' counter against rules.max_retries: spending
    // it here meant a row re-dialled twice by the reaper arrived at no_answer already
    // "exhausted", and the family was told the parent didn't answer after 2 tries with no
    // retry ever actually placed. called_at was the second version of the same mistake:
    // it means "the call was placed", and stamping it on a call that had never been placed
    // made the dashboard render "Last check-in 9:03am" for a check-in that never happened,
    // and (before the queue in 0033 replaced it) made hasCoveredCallToday suppress that
    // day's appointment reminder. One counter, two meanings, twice over. This column means
    // exactly one thing.
    // Only after at least one redial has actually been claimed — otherwise a row first
    // seen long after it was created is abandoned without ever being retried, which is the
    // opposite of what this reaper is for.
    const strandedForMinutes = (now.getTime() - new Date(row.created_at).getTime()) / 60000;
    const giveUp = Boolean(row.stale_redial_at) && strandedForMinutes > STALE_REDIAL_GIVEUP_MINUTES;
    // The predicate on stale_redial_at is what makes this a claim. Guarding only on
    // status='scheduled' meant two overlapping invocations both matched the same row, both
    // "claimed" it and both dialled — two real phone calls to the same person. The column
    // was named for the claim without the guard that implements it.
    const { data: claimed, error: claimError } = await db
      .from("calls")
      .update({ stale_redial_at: now.toISOString() })
      .eq("id", row.id)
      .eq("status", "scheduled")
      .or(`stale_redial_at.is.null,stale_redial_at.lt.${staleThreshold}`)
      .select("id")
      .maybeSingle();
    // Distinguished, because they mean opposite things: no error and no row = another tick
    // holds the claim, which is fine; an error = this reaper did nothing and said nothing.
    // A missing column or a permissions change would otherwise turn the whole recovery path
    // into a silent no-op — no redial, no give-up, no alert, and not a line in the logs.
    if (claimError) {
      log.error("cron.stale_redial_claim_failed", { call_id: row.id, parent_id: parent.id, err: claimError });
      continue;
    }
    if (!claimed) continue;

    if (giveUp) {
      const { data: closed, error: closeError } = await db
        .from("calls")
        .update({ status: "failed" })
        .eq("id", row.id)
        .eq("status", "scheduled")
        .select("id")
        .maybeSingle();
      // Adding .select() here (to decide whether to notify) silently dropped the error
      // check that was in this line before — in the commit whose subject was discarded
      // errors turning guards back into silence. Logging "exhausted" while the close-out
      // failed asserts in the logs that a row was closed when it is still scheduled.
      if (closeError) log.error("cron.stale_redial_giveup_failed", { call_id: row.id, err: closeError });
      log.error("cron.stale_redial_exhausted", { call_id: row.id, parent_id: parent.id, stranded_for_minutes: Math.round(strandedForMinutes) });
      // Giving up here was silent. The slot for this time is already 'dispatched' and linked
      // to this row, so it will never expire either — the check-in simply stops existing.
      // Only for a call the queue actually asked for: a stranded manual test call is not a
      // missed check-in and must not be reported to the family as one.
      const giveUpSlot = await slotFor(db, parent.id, row.scheduled_for);
      if (!giveUpSlot.known) log.error("cron.giveup_alert_skipped_unknown_slot", { call_id: row.id, parent_id: parent.id });
      if (closed && giveUpSlot.known && giveUpSlot.found) {
        const time = formatLocalTime(scheduledFor, parent.timezone);
        await notifyFamilyContacts(
          db,
          parent.id,
          "notify_on_miss",
          row.id,
          `Heads up: we couldn't complete ${parent.name}'s check-in around ${time} after several attempts. Please check in with them directly.`,
          { fingerprint: tooLateFingerprint(row.scheduled_for), severity: "safety" }
        );
      }
      continue;
    }

    const medsForSlot = row.scheduled_meds
      ? resolveMedsForSlot(medications, row.scheduled_meds, scheduledFor, parent.timezone)
      : medsAtLocalTime(medications, scheduledFor, parent.timezone);
    const slot = await slotFor(db, parent.id, row.scheduled_for);
    if (!slot.known) {
      // Leave the row exactly as it is and try again next tick, rather than guessing at a
      // purpose. The claim already advanced stale_redial_at, so this costs one attempt.
      log.warn("cron.stale_redial_deferred_unknown_slot", { call_id: row.id, parent_id: parent.id });
      continue;
    }

    // expireLapsedSlots runs earlier in the same tick, and at the boundary the two used to
    // disagree: a 09:00 slot expiring at 11:00 was reported to the family as "too late to
    // call about", and then this reaper computed minutesLate = 120, which is not greater
    // than SLOT_CATCHUP_MINUTES, and re-dialled — placing a real call to the parent
    // seconds after telling their family it was too late to place one. The slot's own
    // state is the authority on whether that slot is still live.
    if (slot.state === "expired" || slot.state === "cancelled") {
      const { error } = await db.from("calls").update({ status: "failed" }).eq("id", row.id).eq("status", "scheduled");
      if (error) log.error("cron.stale_close_after_slot_done_failed", { call_id: row.id, err: error });
      log.info("cron.stale_row_slot_already_closed", { call_id: row.id, parent_id: parent.id, slot_state: slot.state });
      continue;
    }

    await dialAndRecord(
      db,
      row.id,
      parent,
      caregiverName,
      medsForSlot,
      appointmentsToday(appointments, parent.timezone, now),
      watchItems,
      // A manual test call's `calls` row looks exactly like a scheduled one, so re-dialling
      // it with the default purpose let the family be texted "their 8:55pm check-in didn't
      // go out" about a call that was never on the schedule — undoing the whole point of
      // the "manual" purpose the test-call route passes. A scheduled obligation is one the
      // queue asked for, so a row with no slot behind it is the caregiver's own button.
      slot.found ? "scheduled" : "manual"
    );
  }
}

interface ParentContext {
  caregiverName: string;
  /** See QueueContext.sourcesComplete — false when the medications/appointments read failed. */
  sourcesComplete: boolean;
  medications: Medication[];
  appointments: Appointment[];
  watchItems: WatchItem[];
  rules: EscalationRules | null;
  noAnswerCalls: Call[];
  hasPriorCalls: boolean;
}

async function processParent(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  now: Date,
  ctx: ParentContext
): Promise<{ callsTriggered: number; degraded: boolean }> {
  // Paused by the caregiver (hospital stay, travel, family visiting). Returns before any
  // dialing, retrying or miss-alerting: the whole point is silence, so a pause that still
  // produced "didn't answer" texts every day would be worse than useless.
  if (parent.paused_until && new Date(parent.paused_until) > now) {
    log.info("cron.parent_paused", { parent_id: parent.id, paused_until: parent.paused_until });
    // The rest of today's queue goes with the pause. Leaving it pending means every slot
    // the pause covers lapses and reports itself as a missed check-in the moment the pause
    // lifts — the burst that coverageStartsAt existed to suppress, re-created one layer up.
    // Lapsed slots are accounted for first. Cancelling the whole queue swallowed any slot
    // that had already passed its deadline but not yet been expired — a check-in that
    // really was missed, which then never got a calls row and never told anyone, because
    // the caregiver happened to hit Pause a couple of minutes later.
    const expired = await expireLapsedSlots(db, parent, now);
    const cancelled = await cancelPendingSlots(db, parent.id, "paused", now);
    return { callsTriggered: 0, degraded: !expired || !cancelled };
  }

  // Don't ring before the caregiver said their parent would be ready. The first contact is
  // otherwise a cold call from a synthetic voice to someone trained to hang up on exactly
  // that, and being expected is worth more than any wording (see migration 0030).
  if (parent.first_call_after && new Date(parent.first_call_after) > now) {
    log.info("cron.before_first_call_window", { parent_id: parent.id, first_call_after: parent.first_call_after });
    // Lapsed slots are accounted for first. Cancelling the whole queue swallowed any slot
    // that had already passed its deadline but not yet been expired — a check-in that
    // really was missed, which then never got a calls row and never told anyone, because
    // the caregiver happened to hit Pause a couple of minutes later.
    const expired = await expireLapsedSlots(db, parent, now);
    const cancelled = await cancelPendingSlots(db, parent.id, "prewarm_hold", now);
    return { callsTriggered: 0, degraded: !expired || !cancelled };
  }

  // Consent gate (spec section 8): the very first call always goes out so Rosie can ask
  // for consent. Once at least one call has happened, further automatic scheduled calls
  // wait for consent_given_at to be set (the caregiver's manual test-call button, or a
  // future call, can still obtain it) rather than repeatedly cold-calling without consent.
  // An explicit refusal closes the door immediately, without waiting for a prior call to
  // exist — Rosie tells them she won't ring again, and that has to be true.
  const consentBlocksNewCalls =
    Boolean(parent.consent_refused_at && !parent.consent_given_at) || (ctx.hasPriorCalls && !parent.consent_given_at);

  let callsTriggered = 0;
  let degraded = false;
  if (!consentBlocksNewCalls) {
    // Three passes over a table, in place of the derivation the old scheduler rebuilt every
    // tick: write down what today should look like, ring what is due, and account for what
    // lapsed. Each one is a query against explicit columns.
    const materialized = await materializeSlots(db, parent, ctx, now);
    const dispatched = await dispatchDueSlots(db, parent, ctx, now);
    const expired = await expireLapsedSlots(db, parent, now);
    callsTriggered = dispatched.triggered;
    // "Could not do the work" and "there was no work" must not look the same to the caller.
    degraded = !materialized || !dispatched.ok || !expired;

    // Skipped on an incomplete read for the same reason as dispatch: this path re-dials,
    // and an empty medication list would place a call that asks about nothing.
    if (ctx.sourcesComplete) {
      await reapStaleScheduled(db, parent, ctx.caregiverName, ctx.medications, ctx.appointments, now, ctx.watchItems);
    }
  } else {
    // A parent who declined, or who hasn't consented after a first call, must not have
    // yesterday's queue quietly expire into "missed check-in" texts about calls the
    // scheduler was never going to place. Cancelling is the honest state: not missed, not
    // pending — withdrawn.
    // Same as the pause and pre-warm holds: a slot that genuinely lapsed before the gate
    // shut is a missed check-in and is reported, then the rest of the queue is dropped.
    if (!(await expireLapsedSlots(db, parent, now))) degraded = true;
    if (!(await cancelPendingSlots(db, parent.id, "consent_gate", now))) degraded = true;
  }

  // Retries sat outside the consent gate, which meant a parent who missed the morning call,
  // picked up a later one and declined got re-dialled the same day — moments after Rosie
  // had promised she wouldn't ring again. Any outstanding no-answer rows are closed out
  // instead, so they don't sit in the queue waiting for consent that isn't coming.
  if (consentBlocksNewCalls) {
    // Clear only rows stranded at 'scheduled' — a dial that never happened, which holds
    // calls_parent_active_unique and makes /api/parents/test-call return 409 forever. That
    // test call is the documented way back out of the gate (dashboard banner and refusal
    // SMS both point at it), so leaving it blocked made the gate inescapable.
    //
    // 'no_answer' rows are deliberately left alone. Closing them out as 'failed' rewrote
    // the history the gate reads: a parent who never consented and simply didn't answer had
    // their only call flipped, parents_with_calls stopped returning them, and the gate
    // re-opened on the following tick — cold-calling resumed. Retries are already skipped
    // here, so there is nothing to gain by touching them.
    const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const { data: strandedScheduled } = await db
      .from("calls")
      .select("id")
      .eq("parent_id", parent.id)
      .eq("status", "scheduled")
      .lt("created_at", staleThreshold);

    for (const row of (strandedScheduled ?? []) as Array<{ id: string }>) {
      // Safe to close out: dial_attempted_at (0027) was written before the dial, so this
      // cannot erase the consent gate's evidence the way earlier versions did. Keeping the
      // historical note deliberately — this line has been wrong three times, each time by
      // reading a value written after the operation that fails.
      const { error } = await db
        .from("calls")
        .update({ status: "failed" })
        .eq("id", row.id)
        .eq("status", "scheduled");
      if (error) log.error("cron.close_stranded_failed", { parent_id: parent.id, call_id: row.id, err: error });
    }
    if ((strandedScheduled ?? []).length > 0) {
      log.info("cron.cleared_stranded_no_consent", { parent_id: parent.id, cleared: strandedScheduled!.length });
    }
  } else if (ctx.rules && ctx.sourcesComplete) {
    // The third dial path, and it was the one left ungated. With medications defaulted to
    // [] by a failed read, a retry rings the parent and asks about nothing, consumes an
    // attempt, and the "didn't answer" text that eventually follows names nothing that was
    // missed — the same reasoning already written on dispatch and the stale reaper.
    await processRetries(db, parent, ctx.caregiverName, ctx.rules, ctx.medications, ctx.appointments, ctx.noAnswerCalls, now, ctx.watchItems);
  } else if (ctx.rules) {
    log.warn("cron.retries_skipped_incomplete_sources", { parent_id: parent.id });
  }

  return { callsTriggered, degraded };
}

export async function GET(request: Request) {
  // Fail closed when the secret is missing. Comparing against `Bearer ${undefined}` meant
  // an unset CRON_SECRET didn't disable auth, it published a known password — anyone
  // sending "Bearer undefined" could drive the scheduler and place real phone calls.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("cron.secret_missing");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const now = new Date();

  // Paged. PostgREST caps an unbounded select at its configured maximum and says nothing
  // about it, so past that cap some households simply stop being processed: no call, no
  // alert, no error — the same silent-truncation class migration 0024 was written to fix
  // for `calls`. Ordered by a stable unique key so paging can't skip or repeat a row.
  const parentList: Parent[] = [];
  const PARENT_PAGE_SIZE = 500;
  // Advances by what came back and stops on an empty page, rather than treating a short
  // page as the last one. PostgREST enforces its own `max-rows` cap: if that is set below
  // PARENT_PAGE_SIZE then *every* page is short, so "short means last" stops after one page
  // and silently drops every household past the cap — which is the exact failure this loop
  // was added to prevent, and the one migration 0024 fixed for `calls`.
  for (let from = 0; ; ) {
    const { data: page, error: parentsError } = await db
      .from("parents")
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + PARENT_PAGE_SIZE - 1);
    if (parentsError) {
      return NextResponse.json({ error: parentsError.message }, { status: 500 });
    }
    const rows = (page ?? []) as Parent[];
    if (rows.length === 0) break;
    parentList.push(...rows);
    from += rows.length;
  }
  if (parentList.length === 0) {
    const { error } = await db.from("cron_heartbeat").update({ last_tick_at: now.toISOString() }).eq("id", true);
    if (error) console.error("Failed to update cron heartbeat", error);
    return NextResponse.json({ ok: true, callsTriggered: 0 });
  }

  const parentIds = parentList.map((p) => p.id);
  const caregiverIds = [...new Set(parentList.map((p) => p.caregiver_id))];
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // A call stuck 'in_progress' means Vapi never sent an end-of-call-report for it (a
  // dropped webhook, a crashed call, etc.) — without this it would linger forever,
  // never retried and never escalated to family. Max call duration is 5 minutes, so 10
  // is a safe buffer before assuming it's not coming back. Routing it into 'no_answer'
  // puts it through the exact same retry/miss-alert pipeline as an actual no-answer.
  const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { error: reapError } = await db
    .from("calls")
    .update({ status: "no_answer" })
    .in("parent_id", parentIds)
    .eq("status", "in_progress")
    .lt("called_at", staleThreshold);
  if (reapError) console.error("Failed to reap stale in_progress calls", reapError);

  // One batch of queries for all parents instead of per-parent round-trips, so tick
  // latency stays roughly constant as the number of caregivers grows.
  // Positional destructuring of a long Promise.all is easy to get wrong when a query is
  // inserted mid-array — doing exactly that silently swapped the watch-items and
  // prior-calls results, which disabled the consent gate entirely. Named properties so
  // adding a query can't reorder anything.
  const {
    caregivers: caregiversRes,
    meds: medsRes,
    appts: apptsRes,
    rules: rulesRes,
    noAnswer: noAnswerRes,
    watch: watchRes,
    anyCalls: anyCallsRes,
  } = await allNamed({
    caregivers: db.from("caregivers").select("id, name").in("id", caregiverIds),
    meds: db.from("medications").select("*").in("parent_id", parentIds).eq("active", true),
    appts: db.from("appointments").select("*").in("parent_id", parentIds),
    rules: db.from("escalation_rules").select("*").in("parent_id", parentIds),
    noAnswer: db
      .from("calls")
      .select("*")
      .in("parent_id", parentIds)
      .eq("status", "no_answer")
      .gte("scheduled_for", oneDayAgo.toISOString()),
    watch: db.from("watch_items").select("*").in("parent_id", parentIds),
    // Only counts as a "prior call" for consent-gating if a real dial was actually
    // attempted. dialAndRecord explicitly sets status='failed' only when Vapi itself
    // rejected the call (never rang) — every other status (including 'scheduled', which
    // can mean "Vapi call succeeded but our own bookkeeping write failed right after")
    // means a real call did go out. Filtering on vapi_call_id instead would have let this
    // permanently read as "no prior calls" whenever that bookkeeping write fails, since
    // vapi_call_id is one of the fields that write sets — silently disabling the consent
    // gate and letting the system keep cold-calling the parent without consent.
    // Aggregated server-side (migration 0024) rather than fetching every call row and
    // de-duplicating here. PostgREST silently caps response rows, so the old approach
    // meant that once total call history outgrew the cap, parents whose rows fell outside
    // the page read as "never called" — flipping consentBlocksNewCalls to false and
    // resuming cold-calls to people who never consented, with nothing in the logs.
    anyCalls: db.rpc("parents_with_calls", { p_parent_ids: parentIds }),
  });

  const caregiverNameById = new Map<string, string>(
    (caregiversRes.data ?? []).map((c) => [c.id as string, c.name as string])
  );
  if (medsRes.error) log.error("cron.medications_query_failed", { err: medsRes.error });
  if (apptsRes.error) log.error("cron.appointments_query_failed", { err: apptsRes.error });
  // watch_items is in here because an `always_alert` item is a safety instruction: a call
  // placed without it can hear the thing the family said to always escalate and treat it as
  // conversation. It defaulted to [] on a failed read exactly like medications did.
  if (watchRes.error) log.error("cron.watch_items_query_failed", { err: watchRes.error });
  // caregivers is deliberately NOT in here. A failed read degrades the spoken name to "your
  // family", which is a worse call but still a real check-in; blocking every household's
  // calls over it would trade a cosmetic fault for silence.
  if (caregiversRes.error) log.error("cron.caregivers_query_failed", { err: caregiversRes.error });
  const sourceReadsOk = !medsRes.error && !apptsRes.error && !watchRes.error;
  const medsByParent = groupByParentId((medsRes.data ?? []) as Medication[]);
  const watchByParent = groupByParentId((watchRes.data ?? []) as WatchItem[]);
  const apptsByParent = groupByParentId((apptsRes.data ?? []) as Appointment[]);
  const rulesByParent = new Map<string, EscalationRules>(
    ((rulesRes.data ?? []) as EscalationRules[]).map((r) => [r.parent_id, r])
  );
  const noAnswerByParent = groupByParentId((noAnswerRes.data ?? []) as Call[]);
  if (anyCallsRes.error) {
    // Fail closed: if we can't tell who has already been called, assume everyone has, so
    // the consent gate stays shut rather than defaulting to "never called" and cold-calling.
    log.error("cron.prior_calls_lookup_failed", { err: anyCallsRes.error });
  }
  const priorCallLookupFailed = Boolean(anyCallsRes.error);
  const parentIdsWithPriorCalls = new Set(
    ((anyCallsRes.data ?? []) as Array<{ parent_id: string }>).map((r) => r.parent_id)
  );

  const counts = await Promise.all(
    parentList.map((parent) =>
      processParent(db, parent, now, {
        caregiverName: caregiverNameById.get(parent.caregiver_id) ?? "your family",
        // A failed read defaults to [], which is indistinguishable from "no medications" —
        // and materialisation reconciles, so that empty plan would DELETE today's queue and
        // leave slots that never expire and never alert. Say so instead of guessing.
        sourcesComplete: sourceReadsOk,
        medications: medsByParent.get(parent.id) ?? [],
        appointments: apptsByParent.get(parent.id) ?? [],
        watchItems: watchByParent.get(parent.id) ?? [],
        rules: rulesByParent.get(parent.id) ?? null,
        noAnswerCalls: noAnswerByParent.get(parent.id) ?? [],
        // On lookup failure every parent is treated as already-called, which keeps the
        // consent gate shut. The opposite default would cold-call people who never agreed.
        hasPriorCalls: priorCallLookupFailed || parentIdsWithPriorCalls.has(parent.id),
      })
    )
  );
  const callsTriggered = counts.reduce((sum, r) => sum + r.callsTriggered, 0);
  const degradedParents = counts.filter((r) => r.degraded).length;

  // Drop transcripts past the retention window. Nothing else in the codebase ever deleted
  // one: across 29 migrations there was no TTL and no age-based sweep, so every word an
  // elderly person had said about their own health was kept indefinitely, while the privacy
  // policy told them consent could be withdrawn — which only ever meant prospectively.
  //
  // summary/mood/concerns stay, which is all describeChanges and the dashboard need; only
  // the raw conversation goes. Run here rather than as a separate job so it cannot be
  // forgotten, and bounded so one slow sweep can't stall a tick that has calls to place.
  const retentionCutoff = new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * 86400000).toISOString();
  // Ordered because PostgREST rejects a limited UPDATE without one — the previous form
  // errored on every tick and only produced a log line, while /privacy told people
  // transcripts "are automatically deleted after 30 days". Keyed off created_at rather than
  // called_at: a call whose post-dial write failed keeps called_at null yet still receives a
  // transcript from the webhook, so exactly the rows produced by known bookkeeping failures
  // were the ones retained forever.
  const { data: expired, error: retentionError } = await db
    .from("calls")
    .update({ transcript: null })
    .lt("created_at", retentionCutoff)
    .not("transcript", "is", null)
    .order("created_at", { ascending: true })
    .select("id")
    .limit(500);
  if (retentionError) {
    log.error("cron.transcript_retention_failed", { err: retentionError });
  } else if (expired && expired.length > 0) {
    log.info("cron.transcripts_expired", { count: expired.length, older_than_days: TRANSCRIPT_RETENTION_DAYS });
  }

  // /api/health reads this to tell whether the external scheduler is still running.
  //
  // NOT stamped when any parent's queue work failed. Every queue operation fails closed to
  // a log line, which is right on its own, but the tick was then returning ok:true and
  // marking itself healthy regardless — so a missing table or a revoked grant produced a
  // scheduler that placed zero calls, raised zero alerts, and reported success to
  // cron-job.org and to /api/health. On a product whose promise is that silence means
  // everything is fine, that is the worst-shaped failure available. Withholding the
  // heartbeat turns it into the one alarm this system already has.
  if (degradedParents > 0) {
    log.error("cron.tick_degraded", { parents: parentList.length, degraded_parents: degradedParents, calls_triggered: callsTriggered });
    return NextResponse.json(
      { ok: false, error: "queue operations failed; heartbeat withheld", degradedParents, callsTriggered },
      { status: 500 }
    );
  }

  const { error: heartbeatError } = await db
    .from("cron_heartbeat")
    .update({ last_tick_at: now.toISOString() })
    .eq("id", true);
  if (heartbeatError) log.error("cron.heartbeat_failed", { err: heartbeatError });

  // Every tick leaves a trace, including the quiet ones — "the scheduler ran and decided
  // there was nothing to do" and "the scheduler never ran" look identical otherwise, and
  // that distinction is the whole question when a call doesn't happen.
  log.info("cron.tick", { parents: parentList.length, calls_triggered: callsTriggered });

  return NextResponse.json({ ok: true, callsTriggered });
}
