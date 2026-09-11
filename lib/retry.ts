import { minutesBetween } from "@/lib/schedule";
import type { Call, EscalationRules } from "@/types/db";

export type RetryDecision = "wait" | "retry" | "exhausted";

/** Pure decision for a no_answer call: wait longer, retry now, or stop (retries exhausted). */
export function retryDecision(call: Call, rules: EscalationRules, now: Date = new Date()): RetryDecision {
  if (!call.called_at) return "wait";
  if (minutesBetween(now, new Date(call.called_at)) < rules.retry_after_minutes) return "wait";
  return call.retry_count >= rules.max_retries ? "exhausted" : "retry";
}
