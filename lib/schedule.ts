import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { CALLING_HOURS_START, isWithinCallingHours } from "@/lib/callwindow";
import type { Appointment, Medication } from "@/types/db";

function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function timeOfDayToMinutes(timeOfDay: string): number {
  const [h, m] = timeOfDay.split(":").map(Number);
  return h * 60 + m;
}

function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * UTC instants for the start and end of "today", local to `timezone`. Used to query
 * `calls` by scheduled_for within the parent's own calendar day, not the server's.
 */
export function localDayBoundsUtc(timezone: string, now: Date = new Date()): { startUtc: Date; endUtc: Date } {
  const local = toZonedTime(now, timezone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  return {
    startUtc: fromZonedTime(`${dateStr}T00:00:00.000`, timezone),
    endUtc: fromZonedTime(`${dateStr}T23:59:59.999`, timezone),
  };
}

/**
 * Medications due by (at or before) `now`, local to the parent's timezone — not a narrow
 * forward-looking window. A slot that's already due today but not yet dialed keeps showing
 * up on every tick until it's actually handled, so a delayed or skipped cron tick still
 * catches it later the same day instead of silently missing it forever. The unique
 * (parent_id, scheduled_for) constraint on `calls` (enforced in scheduleAndDial) is what
 * prevents this from re-dialing an already-handled slot.
 */
export function medsDueNow(
  medications: Medication[],
  timezone: string,
  now: Date = new Date()
): Medication[] {
  const local = toZonedTime(now, timezone);
  const nowMinutes = minutesSinceMidnight(local);
  const todayKey = localDateKey(local);

  return medications.filter((m) => {
    if (!m.active) return false;
    if (m.start_date && todayKey < m.start_date) return false;
    if (m.end_date && todayKey > m.end_date) return false;
    return timeOfDayToMinutes(m.time_of_day) <= nowMinutes;
  });
}

/** Appointments whose starts_at falls on "today" local to the parent's timezone. */
export function appointmentsToday(
  appointments: Appointment[],
  timezone: string,
  now: Date = new Date()
): Appointment[] {
  const todayKey = localDateKey(toZonedTime(now, timezone));
  return appointments.filter((a) => {
    const apptLocal = toZonedTime(new Date(a.starts_at), timezone);
    return localDateKey(apptLocal) === todayKey;
  });
}

/**
 * The UTC instant representing "today at this time_of_day" in the parent's timezone.
 *
 * Uses fromZonedTime to resolve the UTC offset AT THE TARGET TIME, not at `now`. An
 * earlier version borrowed now's offset and applied it to the target — wrong whenever
 * now and the target fall on opposite sides of a same-day DST transition (e.g. now is
 * 1am pre-transition, target is 9am post-transition): the two instants can have
 * different UTC offsets, and reusing now's would shift the result by an hour. Verified
 * against both the spring-forward and fall-back transition days, under a UTC system
 * clock (matching Vercel's runtime) where the bug was actually reproducible.
 */
export function scheduledForToday(timeOfDay: string, timezone: string, now: Date = new Date()): Date {
  const local = toZonedTime(now, timezone);
  const [h, m] = timeOfDay.split(":").map(Number);

  const pad = (n: number) => String(n).padStart(2, "0");
  const localDateTime = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(h)}:${pad(m)}:00`;
  return fromZonedTime(localDateTime, timezone);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}

/** "9:05am"-style rendering of a UTC instant in the parent's timezone. */
export function formatLocalTime(date: Date, timezone: string): string {
  const local = toZonedTime(date, timezone);
  const hours = local.getHours();
  const minutes = local.getMinutes();
  const period = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")}${period}`;
}

// How long before an appointment to place a reminder call, for parents with no
// medications due that day — otherwise appointments only ever get mentioned as a
// side note inside a medication-triggered call, and an appointment-only parent (or a
// day with an appointment but no medication due) would never get called at all.
const APPOINTMENT_REMINDER_MINUTES_BEFORE = 60;

/**
 * When to actually ring about an appointment, or null if we shouldn't.
 *
 * Unlike `medications.time_of_day`, which lib/validation.ts refuses outside calling hours,
 * `starts_at` is a real-world time we don't control — a 7am cardiology appointment is a
 * perfectly ordinary thing for a caregiver to enter. Subtracting a flat hour from it
 * produced a 6am reminder, and every dial path refuses to ring at 6am. The row got
 * created, the dial was refused, and (before the fix in lib/dial.ts) nobody was told:
 * a deterministic dead end that repeated for every early appointment.
 *
 * So the reminder is moved to the moment the window opens when that still leaves time to
 * be useful, and otherwise dropped. Dropping is safe in a way that silence normally is not
 * here: today's appointments are passed to *every* call as `appointments_today`, so the
 * appointment is still spoken about on the regular check-in. What's given up is only the
 * extra dedicated reminder call, not the caregiver's visibility of the appointment.
 */
export function reminderSlotFor(appointment: Appointment, timezone: string): Date | null {
  const startsAt = new Date(appointment.starts_at);
  const raw = new Date(startsAt.getTime() - APPOINTMENT_REMINDER_MINUTES_BEFORE * 60000);
  if (isWithinCallingHours(raw, timezone)) return raw;

  // Too early: pull it forward to when we're first willing to ring. Only worth doing if
  // the appointment hasn't already started by then — a "reminder" after the fact is worse
  // than none, and it would occupy the slot a real missed-call alert needs.
  const local = toZonedTime(raw, timezone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const windowOpens = fromZonedTime(
    `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(CALLING_HOURS_START)}:00:00`,
    timezone
  );
  if (raw.getTime() < windowOpens.getTime() && windowOpens.getTime() < startsAt.getTime()) return windowOpens;

  // Too late in the evening (or the clamp would land past the appointment). The regular
  // check-in still mentions it; we are not ringing an elderly person late at night to
  // remind them about an appointment.
  return null;
}

/**
 * Medications whose time_of_day matches the local hour:minute of `scheduledFor`.
 * A call row's scheduled_for keeps its original slot time across retries (only
 * called_at/retry_count change), so this recovers "which meds were this call for".
 */
export function medsAtLocalTime(medications: Medication[], scheduledFor: Date, timezone: string): Medication[] {
  const local = toZonedTime(scheduledFor, timezone);
  const key = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  return medications.filter((m) => m.time_of_day.startsWith(key));
}
