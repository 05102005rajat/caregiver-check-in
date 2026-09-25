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
 * So: one-to-one, by BEST fit rather than first fit. Each answer is scored against every
 * dose it could be about — an exact name beats a longer one, a longer one beats a shorter —
 * and claims one dose from the top-scoring group, preferring a dose nothing has claimed yet.
 * An answer whose top-scoring doses are all taken is spent, not cascaded down to a
 * worse-fitting name.
 *
 * Each half of that earns its place:
 *
 *   - Best fit, not first fit, or "metformin er 500mg" lands on plain "Metformin" and the
 *     warning names the one drug that WAS confirmed.
 *   - No cascade, or two spellings of one drug ("vitamin d3", "vitamin d3 1000 iu") account
 *     for a separate Vitamin D the call never mentioned. That is the unsafe direction.
 *   - Prefer a free dose WITHIN the top group, or two rows of the same drug at the same hour
 *     (500mg and 1000mg — a real regimen) can never both be accounted for, and that
 *     household's all-clear is suppressed every day forever. That is the silent direction.
 *     This only helps when the call produced two answers. A live run showed the extractor
 *     collapsing "I took the 500 and the 1000" into a single "Metformin", which still leaves
 *     row two unaccounted and the call silent. Deduplicating identical scheduled names would
 *     paper over it by letting one answer cover both rows — the unsafe direction, pinned
 *     against by a test — so the partial fix stands and the gap is written down instead.
 *
 * The trade is deliberate: an answer is never stretched across two doses, so a genuinely
 * unmentioned dose stays reported and the family gets silence rather than a false "All
 * good." Silence is the safe failure here, but it is still a failure — see the note on
 * `webhook.meds_unaccounted` in HANDOVER (Known design debt).
 */
export function unaccountedMedications(scheduled: string[], accounted: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  // Same shape as the webhook's isKnownMed: substring either way, but only once both sides
  // are long enough that a short name cannot match everything.
  const fuzzy = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));

  const doses = scheduled.map(norm);
  const claimed = new Set<number>();

  for (const got of accounted.map(norm)) {
    const candidates = doses.map((dose, i) => ({ dose, i })).filter(({ dose }) => dose === got || fuzzy(dose, got));
    if (candidates.length === 0) continue;

    // The dose this answer is MOST LIKELY about: an exact name if there is one, otherwise the
    // most specific (longest) name it could be. Exact wins over longer, or "vitamin d" would
    // claim the "vitamin d3" entry and leave its own unaccounted.
    // Closeness, not raw length. "Longest wins" is right only when the answer is more
    // specific than the dose name ("metformin er 500mg" belongs to "Metformin ER", not
    // "Metformin") — but when the answer is SHORTER than several dose names, the most
    // generic one is the better fit, and preferring the longest hands "vitamin d" to a
    // "Vitamin D3 1000 IU" entry. Negative distance orders both cases correctly with one
    // rule, and an exact name still beats every approximation.
    const rank = ({ dose }: { dose: string }) => (dose === got ? 1e6 : 0) - Math.abs(dose.length - got.length);
    const bestRank = Math.max(...candidates.map(rank));
    const equallyGood = candidates.filter((c) => rank(c) === bestRank);

    // Among names that fit EQUALLY well, take one that is still free. Two rows of the same
    // drug in one slot is a real regimen (500mg and 1000mg at the same hour, and nothing in
    // validation rejects it) — both entries are an identical, exact fit, so without this the
    // second confirmation resolved to the first entry again, was spent, and the second row
    // stayed unaccounted forever. That household would log a warning and take the silent
    // branch after every clean call: no daily line, ever, and no way to tell that apart from
    // a dead scheduler.
    const free = equallyGood.find((c) => !claimed.has(c.i));

    // But spent either way. A confirmation whose best-fitting names are ALL claimed does not
    // fall through to a worse-fitting one — that cascade is what let two variant spellings of
    // a single drug ("vitamin d3", "vitamin d3 1000 iu") account for a separate Vitamin D
    // dose the call never mentioned, and told the family "All good." It is also what made the
    // unaccounted warning name the wrong drug, by letting a generic name swallow a specific
    // answer before the specific entry could claim it. The distinction is fit: an equally
    // good name is the same dose said twice, a worse one is a different drug.
    if (free) claimed.add(free.i);
  }

  return doses.filter((_, i) => !claimed.has(i));
}
