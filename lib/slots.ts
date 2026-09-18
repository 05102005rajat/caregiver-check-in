import { callingWindowEnd, isWithinCallingHours } from "@/lib/callwindow";
import { appointmentsToday, localDayBoundsUtc, medsAtLocalTime, medsDueNow, reminderSlotFor, scheduledForToday } from "@/lib/schedule";
import type { Appointment, Medication } from "@/types/db";

/**
 * Planning the day's calls as rows, instead of re-deriving them every tick.
 *
 * `medsDueNow` answers "was this slot ever due today", and that answer stays true for the
 * rest of the day after the slot has been handled, missed, or abandoned. Everything the
 * scheduler needed on top of it — a catch-up deadline, two separate "too late" branches, a
 * coverage window, and an extra query to stop the appointment fallback double-calling —
 * existed to reconstruct facts that nothing had written down.
 *
 * A slot has a lifetime: it becomes due, it stays callable for a while, then it stops. Once
 * that is a row with `due_at` and `expires_at`, the scheduler is three queries — what is
 * due, what has expired, what is stale — and the derivations go away. See migration 0033.
 */

/**
 * How long after `due_at` a slot stays callable.
 *
 * Absorbs a delayed or skipped cron tick without ever placing a very-late, confusing
 * "did you take your 9am pill?" call in the afternoon. Previously MAX_CATCHUP_MINUTES,
 * compared against a derived slot time in three different places; now it is used once, to
 * compute a column.
 */
export const SLOT_CATCHUP_MINUTES = 120;

export interface PlannedSlot {
  dueAt: Date;
  expiresAt: Date;
  kind: "medication" | "appointment";
  medNames: string[];
  appointmentId: string | null;
}

/** Slots that could not be planned, so the caller can say so out loud rather than drop them. */
export interface UncallableSlot {
  reason: "outside_calling_hours";
  timeOfDay: string;
  medNames: string[];
}

export interface SlotPlan {
  slots: PlannedSlot[];
  uncallable: UncallableSlot[];
}

/**
 * A slot stops being callable at the catch-up deadline OR when the calling window shuts,
 * whichever comes first.
 *
 * Without the window term, a slot due at 20:30 stays "callable" until 22:30, and every tick
 * in between asks lib/dial.ts for a call it refuses. Bounding it here means the queue never
 * requests a dial that cannot be placed.
 */
function expiryFor(dueAt: Date, timezone: string, notAfter?: Date): Date {
  const catchupDeadline = new Date(dueAt.getTime() + SLOT_CATCHUP_MINUTES * 60000);
  const windowCloses = callingWindowEnd(dueAt, timezone);
  const candidates = [catchupDeadline, windowCloses, ...(notAfter ? [notAfter] : [])];
  return candidates.reduce((earliest, d) => (d < earliest ? d : earliest));
}

/**
 * The slots that should exist for this parent's local day.
 *
 * Idempotent by construction: it describes the day, and the unique (parent_id, due_at)
 * index decides what is actually new. Callers materialise the result on every tick.
 *
 * `coverageStartsAt` is the one derivation that survives the redesign, and it has to. It
 * answers "were we responsible for this slot", which is a genuinely different question from
 * "has it already passed": a slot that elapsed during a pause was never ours to miss, while
 * a slot that elapsed because the scheduler was down absolutely was, and the family needs
 * telling. Materialising only future slots would collapse those two into silence — the one
 * direction this product must never fail in.
 */
export function planSlotsForDay(
  medications: Medication[],
  appointments: Appointment[],
  timezone: string,
  now: Date,
  coverageStartsAt: Date
): SlotPlan {
  const slots: PlannedSlot[] = [];
  const uncallable: UncallableSlot[] = [];

  // Every medication slot for today, due or not. medsDueNow is reused only for its
  // active/start_date/end_date filtering; the "<= now" part of it no longer decides
  // anything, because due_at does.
  //
  // Asked at the END of the parent's local day, not `now + 24h`: medsDueNow resolves
  // start_date/end_date against the local date of the instant it is given, and now + 24h
  // is tomorrow — so a medication ending today would be judged against tomorrow's date and
  // silently dropped from today's queue.
  const { endUtc: endOfLocalDay } = localDayBoundsUtc(timezone, now);
  const activeToday = medsDueNow(medications, timezone, endOfLocalDay);
  const byTime = new Map<string, string[]>();
  for (const med of activeToday) {
    const bucket = byTime.get(med.time_of_day);
    if (bucket) bucket.push(med.name);
    else byTime.set(med.time_of_day, [med.name]);
  }

  for (const [timeOfDay, medNames] of byTime) {
    const dueAt = scheduledForToday(timeOfDay, timezone, now);

    // Grandfathered rows. lib/validation.ts refuses a medication time outside calling hours
    // on save, but only on new saves — rows predating that check still exist, and a slot at
    // 22:48 can never be dialled. Materialising it would expire unrung every single night
    // and text the family "missed check-in" daily, which is worse than the status quo.
    // Reported to the caller instead of silently dropped, so it can be surfaced once.
    if (!isWithinCallingHours(dueAt, timezone)) {
      uncallable.push({ reason: "outside_calling_hours", timeOfDay, medNames });
      continue;
    }

    // Not ours to miss: the slot elapsed before this household was our responsibility
    // (during a pause, before the account existed, or inside a deliberate pre-warm hold).
    if (dueAt < coverageStartsAt) continue;

    slots.push({ dueAt, expiresAt: expiryFor(dueAt, timezone), kind: "medication", medNames, appointmentId: null });
  }

  // The appointment fallback exists for a day with an appointment and no medication call —
  // otherwise an appointment-only parent is never rung at all. When the day already has a
  // medication slot, the appointment is spoken about on that call (appointments_today is
  // passed to every dial), so a second call would be the double-call that
  // hasCoveredCallToday used to prevent with an extra query per parent per tick.
  {
    // At most ONE reminder call, the earliest. Looping every appointment into its own slot
    // rang an appointment-only parent three times in a day. Every dial carries
    // appointments_today, so one call names all of them.
    //
    // Planned even when the day already has a medication slot, and NOT skipped here. Whether
    // a second call is wanted depends on whether the first one actually happened, which is a
    // fact about the world at dispatch time, not something the planner can know: gating on
    // "a medication slot exists" meant a parent whose 09:00 slot lapsed unrung got no call
    // at all that day and no appointment reminder either. dispatchDueSlots cancels this slot
    // if a call has already covered the day — which is what hasCoveredCallToday did.
    const candidates = appointmentsToday(appointments, timezone, now)
      // Window-aware: returns null when no reminder could be placed at a reasonable hour.
      .map((appointment) => ({ appointment, dueAt: reminderSlotFor(appointment, timezone) }))
      .filter((c): c is { appointment: Appointment; dueAt: Date } => c.dueAt !== null)
      .filter((c) => c.dueAt >= coverageStartsAt)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
    const earliest = candidates[0];
    if (earliest) {
      slots.push({
        dueAt: earliest.dueAt,
        // Capped at the appointment itself. reminderSlotFor refuses to plan a reminder that
        // could only land after the appointment starts, but the flat two-hour catch-up then
        // handed it back: a 10:00 appointment reminds at 09:00 and stayed callable until
        // 11:00, so a delayed tick rang to "remind" someone about an appointment that began
        // twenty minutes earlier. A reminder after the fact is worse than none.
        expiresAt: expiryFor(earliest.dueAt, timezone, new Date(earliest.appointment.starts_at)),
        kind: "appointment",
        medNames: [],
        appointmentId: earliest.appointment.id,
      });
    }
  }

  // Two appointments an hour apart would otherwise plan two slots at the same due_at and
  // collide on the unique index. First one wins; the rest of the day's appointments are
  // still named inside that call.
  const seen = new Set<number>();
  // Sorted before deduping, so a due_at collision resolves to the earliest slot rather than
  // whichever the medication query happened to return first. Harmless while time_of_day is
  // uniformly HH:MM:SS, but "first one wins" is not what this means.
  slots.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return {
    slots: slots.filter((slot) => {
      const key = slot.dueAt.getTime();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    uncallable,
  };
}

/**
 * When this household became our responsibility.
 *
 * Unchanged in meaning from the old scheduler, but now consulted in exactly one place
 * (planning) instead of being threaded through two "too late" branches. `resumed_at` is
 * still needed: the Resume button clears paused_until rather than moving it, so without it
 * this collapses to created_at the moment someone resumes and replays the whole day.
 */
export function coverageStartsAt(parent: {
  paused_until: string | null;
  resumed_at: string | null;
  first_call_after: string | null;
  consent_given_at: string | null;
  created_at: string | null;
}): Date {
  return new Date(
    Math.max(
      parent.paused_until ? new Date(parent.paused_until).getTime() : 0,
      parent.resumed_at ? new Date(parent.resumed_at).getTime() : 0,
      parent.first_call_after ? new Date(parent.first_call_after).getTime() : 0,
      // Consent belongs here for the same reason a pause does: a slot that elapsed before
      // this parent agreed to be called was never ours to miss. Without it, a parent who
      // consents at 15:00 — via the test-call button the dashboard points at — had that
      // afternoon's tick re-plan the already-elapsed 08:00 and 12:00 slots, revive them
      // from the consent hold's cancellation, and expire each into its own "check-in was
      // missed" text. Different slots, different fingerprints, so nothing merged them: a
      // burst of alarms about calls the system had deliberately declined to place.
      parent.consent_given_at ? new Date(parent.consent_given_at).getTime() : 0,
      parent.created_at ? new Date(parent.created_at).getTime() : 0
    )
  );
}

/**
 * The medications belonging to the most recent slot that is due — what a scheduled call for
 * that slot would carry, and nothing else.
 *
 * Used by the manual test call. medsDueNow is cumulative across the local day by design
 * (that is what makes catch-up work), so handing its whole result to a call asks an elderly
 * person about every dose since breakfast and reports each unconfirmed one as missed.
 */
export function medsForNearestSlot(medications: Medication[], timezone: string, now: Date = new Date()): Medication[] {
  const due = medsDueNow(medications, timezone, now);
  if (due.length === 0) return [];
  const latest = due.reduce((acc, m) => (m.time_of_day > acc ? m.time_of_day : acc), due[0].time_of_day);

  // Bounded by the same catch-up window a scheduled call gets. Without it, a parent whose
  // only dose is at 08:00 gets a test call at 20:00 asking about a twelve-hour-old dose,
  // and anything they don't confirm is reported to the family as "Not taken" — the false
  // alarm this function was written to remove, just moved from "every dose today" to "one
  // stale dose". A scheduled call for that slot would have expired hours earlier.
  const slotAt = scheduledForToday(latest, timezone, now);
  if (now.getTime() - slotAt.getTime() > SLOT_CATCHUP_MINUTES * 60000) return [];

  return due.filter((m) => m.time_of_day === latest);
}

/**
 * Resolves a slot's snapshot of medication names back to rows — one row per name, and the
 * row belonging to THIS slot's time.
 *
 * Both simpler versions are wrong when the same medication is taken twice a day, which
 * nothing prevents (validation only rejects the same name at the same *time*):
 *
 *   filter(m => names.includes(m.name))   -> both rows match, so Rosie is told to ask about
 *                                            "Insulin and Insulin"
 *   find(m => m.name === name)            -> the FIRST row wins, so the 18:00 slot speaks
 *                                            the 08:00 dose. Confusing became wrong.
 *
 * Matching on time_of_day first picks the right one. The name-only fallback covers a slot
 * whose snapshot predates an edit to the schedule — the name is then the best evidence left
 * of what the call was for.
 */
export function medsForSlot(
  medications: Medication[],
  names: string[],
  scheduledFor: Date,
  timezone: string
): Medication[] {
  const atThisTime = medsAtLocalTime(medications, scheduledFor, timezone);
  return names
    .map((name) => atThisTime.find((m) => m.name === name) ?? medications.find((m) => m.name === name))
    .filter((m): m is Medication => Boolean(m));
}
