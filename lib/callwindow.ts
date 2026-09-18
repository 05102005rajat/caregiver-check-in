import { formatInTimeZone } from "date-fns-tz";

/**
 * When it is acceptable to ring someone.
 *
 * This did not exist. A product that autodials cognitively vulnerable people every day had
 * no restriction of any kind on the hour it called: `medications.time_of_day` is an
 * unconstrained `time`, validation accepted 00:00–23:59, `MAX_CATCHUP_MINUTES` permitted a
 * dial two hours after the slot, and `retryDecision` never asked how late it was at all. A
 * scheduler outage from 9am to 8pm — which /api/health detects but cannot prevent — ended
 * with the 8pm tick dialling the 9am slot, and a stranded row could be re-dialled every
 * tick for two hours.
 *
 * Waking an 85-year-old at 11pm to ask about a pill is worse than not calling. It is also
 * the kind of thing that gets a service uninstalled by the family and written about by a
 * journalist, so the guard is absolute rather than advisory: every dial path goes through
 * lib/dial.ts, and lib/dial.ts refuses outside this window regardless of what the caller
 * believes. Three separate paths (slot loop, retries, stale reaper) previously answered
 * "is it too late" three different ways, and the most dangerous one had no answer.
 */
export const CALLING_HOURS_START = 8; // 08:00 local — not before
export const CALLING_HOURS_END = 21; // 21:00 local — not after

/** The parent's local hour, 0–23. */
export function localHour(now: Date, timeZone: string): number {
  return Number(formatInTimeZone(now, timeZone, "H"));
}

/** Whether it is currently a reasonable hour to ring this parent. */
export function isWithinCallingHours(now: Date, timeZone: string): boolean {
  const hour = localHour(now, timeZone);
  return hour >= CALLING_HOURS_START && hour < CALLING_HOURS_END;
}

/** "9:47pm" in the parent's own timezone, for messages aimed at the caregiver. */
export function describeLocalTime(now: Date, timeZone: string): string {
  return formatInTimeZone(now, timeZone, "h:mmaaa");
}
