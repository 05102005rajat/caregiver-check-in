/**
 * The one-line "nothing is wrong" text, sent after a check-in that found nothing.
 *
 * This reverses a founding decision, deliberately, and the reason is worth keeping.
 *
 * "Silence is the product" is still right about ALERTS: a system that reports everything
 * trains a family to stop reading, and then the one that matters is ignored too. But silence
 * has a flaw it cannot escape — the caregiver cannot tell "Mum is fine" from "the scheduler
 * died and nobody called her". Everything built to catch the second case (the heartbeat, the
 * stale reaper, degraded ticks, the /admin audit) is invisible to them. For a family member
 * in another country, that ambiguity is precisely the anxiety this product exists to remove.
 *
 * It was confirmed the first time a real check-in went perfectly: the maintainer's immediate
 * reaction to a clean call was "why didn't we get a text?" — from the person who built it and
 * knew the rule. A stranger has no chance.
 *
 * Alert fatigue is answered by making the two look nothing alike, not by removing one:
 *
 *   all-clear   ✓ Nora's 8:10am check-in — Aspirin taken. All good.     (one line, daily, identical shape)
 *   attention   Nora's check-in — needs a look:                          (a header and bullets)
 *
 * A reader can tell them apart at a glance in a notification shade, which is the only place
 * this is ever read. The tick is the same every day on purpose: a familiar line is skimmed in
 * half a second, and an unfamiliar one is what makes someone stop.
 */
import { formatLocalTime } from "@/lib/schedule";

export interface AllClearInput {
  parentName: string;
  /** When the check-in happened. */
  at: Date;
  timezone: string;
  /** Medications they confirmed taking on the call, already name-filtered. */
  medsConfirmed: string[];
}

/**
 * Deliberately not "everything is fine" or "all is well". It reports what was CONFIRMED and
 * nothing more: a check-in where nobody mentioned a problem is not evidence that there is no
 * problem, and a daily line that overclaims is how a family stops believing the one that
 * eventually says something is wrong.
 */
export function allClearMessage({ parentName, at, timezone, medsConfirmed }: AllClearInput): string {
  const time = formatLocalTime(at, timezone);
  // Named, not counted. "2 medications taken" is a number a reader has to decode; "Aspirin
  // taken" is the fact they wanted. With several, the names are still shorter than the
  // sentence around them.
  const meds =
    medsConfirmed.length > 0
      ? `${medsConfirmed.join(", ")} taken. `
      : // No dose was due at this hour, which is ordinary and not worth explaining every day.
        "";
  return `✓ ${parentName}'s ${time} check-in — ${meds}All good.`;
}
