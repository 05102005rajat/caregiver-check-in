import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * The two halves of the `<input type="datetime-local">` round-trip, kept together because
 * a bug here is invisible and self-reinforcing.
 *
 * That input produces a bare wall-clock string ("2026-09-20T09:00") with no zone. Resolving
 * it with `new Date(...)` uses whatever zone the code happens to run in — UTC on Vercel —
 * so a 9am Los Angeles appointment was stored as 09:00Z, and the reminder call was placed
 * at 2am local. The display side had the mirror-image bug (rendering the instant as UTC),
 * which hid it: the form showed back the same "09:00" it was given, and then wrote that
 * misreading to the database again on the next save.
 *
 * Both directions must use the parent's zone — the zone the caregiver was thinking in when
 * they picked the time.
 */

/** Wall-clock string as entered in `timeZone` → the absolute instant it names. */
export function localInputToInstant(value: string, timeZone: string): Date {
  return fromZonedTime(value, timeZone);
}

/** An absolute instant → the wall-clock string to show in a datetime-local input. */
export function instantToLocalInput(value: string | Date, timeZone: string): string {
  return formatInTimeZone(value, timeZone, "yyyy-MM-dd'T'HH:mm");
}
