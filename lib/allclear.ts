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

export interface UnconfirmedInput extends AllClearInput {
  /** Scheduled doses the call left without a yes or a no, in their scheduled spelling. */
  unconfirmed: string[];
  /** Everything the call was for, so a drug scheduled twice can be counted. */
  scheduled: string[];
}

/**
 * Sent INSTEAD of the all-clear when the call went fine but a dose could not be matched to
 * anything said on it. Neither alternative is acceptable: "All good." would be a claim about
 * a dose nobody discussed, and silence reads to the caregiver exactly like a dead scheduler
 * on the one day they were owed a line.
 *
 * Shaped as the all-clear's sibling, not as an alert. One line, no tick, no "All good", and
 * no "needs a look" — because most of the time this is our matching being unsure, not the
 * parent skipping a dose, and a family taught that routine ambiguity is an alarm stops
 * reading the alarms. It says what is known and hands them the one thing they can do.
 */
export function unconfirmedMessage({ parentName, at, timezone, medsConfirmed, unconfirmed, scheduled }: UnconfirmedInput): string {
  const time = formatLocalTime(at, timezone);
  const taken = medsConfirmed.length > 0 ? `${medsConfirmed.join(", ")} taken. ` : "";
  return `${parentName}'s ${time} check-in — ${taken}Couldn't confirm: ${describeUnconfirmed(scheduled, unconfirmed)}. Worth asking.`;
}

/**
 * The unconfirmed doses as a caregiver should read them.
 *
 * Two rows of one drug at the same hour (500mg and 1000mg) are one name to the reader, and
 * the extractor routinely collapses "I took the 500 and the 1000" into a single answer. So
 * one row is confirmed and the other is not, and naming it plainly produced "Metformin
 * taken. Couldn't confirm: Metformin." — a sentence that contradicts itself and gives the
 * reader nothing to ask. Counted instead: "1 of 2 Metformin doses".
 */
export function describeUnconfirmed(scheduled: string[], unconfirmed: string[]): string {
  const key = (s: string) => s.trim().toLowerCase();
  const seen = new Map<string, { name: string; count: number }>();
  for (const name of unconfirmed) {
    const k = key(name);
    const entry = seen.get(k) ?? { name, count: 0 };
    entry.count++;
    seen.set(k, entry);
  }
  return [...seen.entries()]
    .map(([k, { name, count }]) => {
      const total = scheduled.filter((s) => key(s) === k).length;
      return total > count ? `${count} of ${total} ${name} doses` : name;
    })
    .join(", ");
}

export interface UnconfirmedLineInput {
  scheduled: string[];
  unconfirmed: string[];
  /** What the call DID establish, so the reader can see it is likely a naming mismatch. */
  medsConfirmed: string[];
  /**
   * Set when the call is not a place to talk about doses at all: nobody answered, the call
   * was unreadable, or the text is an emergency. "Couldn't confirm" there reads as though the
   * parent was asked and dodged it, blames a pill for our own failure to hear, or — under an
   * URGENT header — points the reader at a tablet as the emergency.
   */
  suppress: boolean;
}

/**
 * The line appended to the CAREGIVER's copy of a concern or request text, or null.
 *
 * Caregiver only, like the standalone unconfirmedMessage: the account holder set the
 * medications up and is the one who can check them. A sibling who asked to hear about
 * concerns did not ask to referee our name matching.
 */
export function unconfirmedLine({ scheduled, unconfirmed, medsConfirmed, suppress }: UnconfirmedLineInput): string | null {
  if (suppress || unconfirmed.length === 0) return null;
  const taken = medsConfirmed.length > 0 ? ` (confirmed: ${medsConfirmed.join(", ")})` : "";
  return `Couldn't confirm: ${describeUnconfirmed(scheduled, unconfirmed)}${taken}`;
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
 * 3. Best fit by name LENGTH. Closer in length is not closer in meaning: "vitamin d3" is one
 *    character from "vitamin d" and eight from "vitamin d3 1000 iu", so a second spelling of
 *    the D3 claimed a plain Vitamin D nobody mentioned ("All good." — unsafe), and in the
 *    other order a correct "vitamin d3" stole the plain entry and left the real D3 reported
 *    outstanding (silent, and the warning named the drug that WAS confirmed).
 *
 * So names are compared WORD BY WORD, which is how a person reads them:
 *
 *   - An answer may add words ("metformin 500mg" is Metformin) or shorten a word to its
 *     start ("vitamin d" could be Vitamin D3), but never CHANGE one. "d3" is not "d", so
 *     "vitamin d3" is never about a plain Vitamin D. That single rule is what the length
 *     heuristic kept approximating and kept getting wrong.
 *   - At least one word must match exactly and be 4+ characters, the same floor isKnownMed
 *     carries, so "zin" cannot anchor a match on its own.
 *
 * Then, one-to-one:
 *
 *   1. Exact names first, across every answer, so a precise answer is never beaten to its
 *      own entry by a looser one that happened to come first in the model's list.
 *   2. Every remaining answer is scored against every dose it could be about: words that
 *      line up, minus words of the dose name the answer did not cover. The top score wins.
 *   3. If the top score is shared by two DIFFERENT names, the answer is ambiguous and
 *      accounts for nothing. A plain "vitamin" with Vitamin D and Vitamin B12 scheduled
 *      could be either, and guessing is how a family gets told about a dose that was not
 *      discussed. Two rows with the SAME name (500mg and 1000mg at the same hour, a real
 *      regimen) are not ambiguous — either answer fits either row — so it takes a free one.
 *   4. If every top-scoring dose is already claimed, the answer is the same dose said
 *      again. It is spent, never passed down to a worse-fitting name.
 *
 * Anything left over is reported, and the webhook tells the caregiver it could not be
 * confirmed (`unconfirmedMessage`) rather than sending "All good." or nothing at all. So
 * being strict here costs a family a slightly less tidy text, never a false one.
 *
 * Returns the SCHEDULED spelling, because it goes into a text the caregiver reads.
 */
export function unaccountedMedications(scheduled: string[], accounted: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  // A plural is the same drug: "fish oils" is Fish oil, "eye drop" is Eye drops. Applied to
  // both sides, so it only has to be consistent, not linguistically right ("-ss" is kept).
  const singular = (w: string) => (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean).map(singular);

  const isStrength = (w: string) =>
    /^\d+(\.\d+)?(mg|mcg|g|iu|ml|units?)?$/.test(w) || /^(mg|mcg|g|iu|ml|units?|tablets?|pills?|capsules?|drop)$/.test(w);

  // How well an answer fits a dose name, or null if it cannot be about that dose at all.
  const fit = (dose: string[], got: string[]): number | null => {
    let lined = 0;
    let anchored = false;
    const unused = [...got];
    for (const w of dose) {
      const exact = unused.indexOf(w);
      if (exact !== -1) {
        unused.splice(exact, 1);
        lined++;
        if (w.length >= 4) anchored = true;
        continue;
      }
      // The answer abbreviated this word ("d" for "d3"). The reverse — the answer's word is
      // LONGER than the dose's — is a different drug, and is why this is a startsWith and
      // not an includes.
      const short = unused.findIndex((g) => w.startsWith(g));
      if (short !== -1) {
        unused.splice(short, 1);
        lined++;
      }
    }
    if (!anchored) return null;
    // An answer may carry extra words ("metformin er 500mg" for Metformin). But once the
    // answer has FAILED to cover a word of the dose name, a leftover word of its own is a
    // contradiction: "vitamin d3" against "vitamin d" leaves "d" uncovered and "d3" over.
    // Strength and units don't count as contradicting: the model routinely reports
    // "metformin 500 mg" for a row named "Metformin ER", and treating that as a different
    // drug would make the household's check-in say "couldn't confirm" every day.
    const missing = dose.length - lined;
    if (missing > 0 && unused.some((g) => !isStrength(g))) return null;
    return lined - missing;
  };

  const doses = scheduled.map((name) => ({ name, key: norm(name), words: words(name) }));
  const claimed = new Set<number>();
  const takeFree = (idxs: number[]) => {
    const i = idxs.find((j) => !claimed.has(j));
    if (i !== undefined) claimed.add(i);
  };

  const fuzzyAnswers: string[][] = [];
  for (const got of accounted) {
    const exact = doses.flatMap((d, i) => (d.key === norm(got) ? [i] : []));
    // An exact answer whose entries are all claimed is a repeat, not a fuzzy answer.
    if (exact.length > 0) takeFree(exact);
    else fuzzyAnswers.push(words(got));
  }

  for (const got of fuzzyAnswers) {
    const scored = doses.flatMap((d, i) => {
      const f = fit(d.words, got);
      return f === null ? [] : [{ i, key: d.key, f }];
    });
    if (scored.length === 0) continue;
    const best = Math.max(...scored.map((c) => c.f));
    const top = scored.filter((c) => c.f === best);
    if (new Set(top.map((c) => c.key)).size > 1) continue;
    takeFree(top.map((c) => c.i));
  }

  return doses.filter((_, i) => !claimed.has(i)).map((d) => d.name);
}
