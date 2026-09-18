import { callingWindowEnd, isWithinCallingHours } from "@/lib/callwindow";
import { appointmentsToday, localDayBoundsUtc, medsDueNow, reminderSlotFor, scheduledForToday } from "@/lib/schedule";
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
function expiryFor(dueAt: Date, timezone: string): Date {
  const catchupDeadline = new Date(dueAt.getTime() + SLOT_CATCHUP_MINUTES * 60000);
  const windowCloses = callingWindowEnd(dueAt, timezone);
  return catchupDeadline < windowCloses ? catchupDeadline : windowCloses;
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
  if (slots.length === 0) {
    for (const appointment of appointmentsToday(appointments, timezone, now)) {
      // Window-aware: returns null when no reminder could be placed at a reasonable hour.
      const dueAt = reminderSlotFor(appointment, timezone);
      if (!dueAt) continue;
      if (dueAt < coverageStartsAt) continue;
      slots.push({
        dueAt,
        expiresAt: expiryFor(dueAt, timezone),
        kind: "appointment",
        medNames: [],
        appointmentId: appointment.id,
      });
    }
  }

  // Two appointments an hour apart would otherwise plan two slots at the same due_at and
  // collide on the unique index. First one wins; the rest of the day's appointments are
  // still named inside that call.
  const seen = new Set<number>();
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
  created_at: string | null;
}): Date {
  return new Date(
    Math.max(
      parent.paused_until ? new Date(parent.paused_until).getTime() : 0,
      parent.resumed_at ? new Date(parent.resumed_at).getTime() : 0,
      parent.first_call_after ? new Date(parent.first_call_after).getTime() : 0,
      parent.created_at ? new Date(parent.created_at).getTime() : 0
    )
  );
}
