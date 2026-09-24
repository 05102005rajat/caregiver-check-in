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

/**
 * Which of the doses this call was about nobody can say yes or no to.
 *
 * Lives here, tested, because the first two attempts at it were both wrong and both inline
 * in a 650-line route handler where nothing could reach them:
 *
 *   1. Exact lowercase equality. `medsConfirmed` holds the MODEL's strings, admitted by a
 *      fuzzy filter precisely because it does not return the scheduled spelling — so
 *      "metformin 500mg" never matched "Metformin", every accounted-for call looked
 *      unaccounted, and the all-clear was suppressed always. Wrong in the safe direction.
 *   2. Fuzzy, but many-to-many. `"vitamin d3".includes("vitamin d")`, so a single confirmed
 *      Vitamin D3 accounted for a separate Vitamin D dose the call never mentioned, and the
 *      family was told "All good." Wrong in the UNSAFE direction, which is worse.
 *
 * So: one-to-one. A confirmed name is consumed by the first dose it accounts for and cannot
 * account for a second. Exact matches are paired first, so "vitamin d3" claims its own
 * entry rather than swallowing the plainer one next to it.
 */
export function unaccountedMedications(scheduled: string[], accounted: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const remaining = accounted.map(norm);
  const take = (predicate: (got: string) => boolean): boolean => {
    const i = remaining.findIndex(predicate);
    if (i === -1) return false;
    remaining.splice(i, 1);
    return true;
  };

  // Same shape as the webhook's isKnownMed: substring either way, but only once both sides
  // are long enough that a short name cannot match everything.
  const fuzzy = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));

  const pending = scheduled.map(norm);
  // Exact first, across the whole list, so a specific name claims its own match before a
  // looser one can absorb it.
  const stillPending = pending.filter((med) => !take((got) => got === med));
  return stillPending.filter((med) => !take((got) => fuzzy(med, got)));
}
