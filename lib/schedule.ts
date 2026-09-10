import { toZonedTime } from "date-fns-tz";
import type { Appointment, Medication } from "@/types/db";

const WINDOW_MINUTES = 5;

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

/** Medications whose time_of_day falls in [now, now + 5min) local to the parent's timezone. */
export function medsDueNow(
  medications: Medication[],
  timezone: string,
  now: Date = new Date()
): Medication[] {
  const local = toZonedTime(now, timezone);
  const nowMinutes = minutesSinceMidnight(local);

  return medications.filter((m) => {
    if (!m.active) return false;
    const medMinutes = timeOfDayToMinutes(m.time_of_day);
    return medMinutes >= nowMinutes && medMinutes < nowMinutes + WINDOW_MINUTES;
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

/** The UTC instant representing "today at this time_of_day" in the parent's timezone. */
export function scheduledForToday(timeOfDay: string, timezone: string, now: Date = new Date()): Date {
  const local = toZonedTime(now, timezone);
  const [h, m] = timeOfDay.split(":").map(Number);
  const localTarget = new Date(local);
  localTarget.setHours(h, m, 0, 0);

  // localTarget's clock fields are correct for the zone but its epoch value is wrong
  // (it was built from a Date already offset into that zone). Recover the real UTC
  // instant by reapplying the same zone offset used to produce `local`.
  const offsetMs = local.getTime() - now.getTime();
  return new Date(localTarget.getTime() - offsetMs);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}
