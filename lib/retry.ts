import { minutesBetween } from "@/lib/schedule";
import type { Call, EscalationRules } from "@/types/db";

export type RetryDecision = "wait" | "retry" | "exhausted";

/**
 * How stale a slot may be before retrying it stops making sense.
 *
 * The slot loop has MAX_CATCHUP_MINUTES and an elaborate "too late to call" branch; this
 * path had nothing, and asked only "has retry_after_minutes elapsed". After a scheduler
 * outage from 9am to 8pm, the 8pm tick would happily dial about a 9am medication. Four
 * hours is generous enough to ride out a normal outage and short enough that the call still
 * makes sense to the person answering it.
 */
export const MAX_RETRY_LATENESS_MINUTES = 240;

/** Pure decision for a no_answer call: wait longer, retry now, or stop (retries exhausted). */
export function retryDecision(call: Call, rules: EscalationRules, now: Date = new Date()): RetryDecision {
  if (!call.called_at) return "wait";

  // Judged from the slot it was for, not from the last attempt — otherwise a chain of
  // retries walks the call arbitrarily far from the time it was actually about.
  const minutesLate = (now.getTime() - new Date(call.scheduled_for).getTime()) / 60000;
  if (minutesLate > MAX_RETRY_LATENESS_MINUTES) return "exhausted";

  if (minutesBetween(now, new Date(call.called_at)) < rules.retry_after_minutes) return "wait";
  return call.retry_count >= rules.max_retries ? "exhausted" : "retry";
}
