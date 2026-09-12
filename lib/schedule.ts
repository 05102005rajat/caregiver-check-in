import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { Appointment, Medication } from "@/types/db";

function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function timeOfDayToMinutes(timeOfDay: string): number {
  const [h, m] = timeOfDay.split(":").map(Number);
  return h * 60 + m;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
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

  return medications.filter((m) => {
    if (!m.active) return false;
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
