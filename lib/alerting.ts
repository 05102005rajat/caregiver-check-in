/**
 * One definition of "does this warrant telling someone".
 *
 * There were three, and they disagreed:
 *
 *   app/api/vapi/webhook  hasConcern      concerns | meds missed | mood concerning|unknown
 *   evals/score.ts        wouldAlert      (mirrored the above, by hand)
 *   lib/insights.ts       needsAttention  concerns | meds missed | failed | no_answer
 *
 * The dashboard reads the third one, so a call that texted the family "needs a look"
 * because Claude returned an unparseable mood showed up on the dashboard unflagged — the
 * caregiver gets an alarming text and finds a page telling them everything is fine. Three
 * hand-maintained copies of one rule will keep drifting, and the copy that drifts is the
 * one the human actually looks at.
 */

/** The facts an alert decision is made from, however they were obtained. */
export interface AttentionFacts {
  concerns: string[];
  medsMissed: string[];
  mood: string | null;
  /** Call outcome, where known. A call that never connected needs attention too. */
  status?: string | null;
  /**
   * The extractor's own "this may need help right now" flag. Without it here, a call where
   * the model raised urgent but listed no concerns and read the mood as fine sent NOTHING —
   * the "please call her now" path was unreachable unless some other signal had already
   * fired, which is the one case where it least should depend on another signal.
   */
  urgent?: boolean;
}

/**
 * `unknown` counts. It is what normalize() returns for a malformed or empty model
 * response, so treating it as benign would silently convert "we could not understand this
 * call" into "everything is fine" — the one direction this product must never fail in.
 */
const ATTENTION_MOODS = new Set(["concerning", "unknown"]);
const ATTENTION_STATUSES = new Set(["failed", "no_answer"]);

export function warrantsAttention(facts: AttentionFacts): boolean {
  return (
    facts.urgent === true ||
    facts.concerns.length > 0 ||
    facts.medsMissed.length > 0 ||
    (facts.mood !== null && facts.mood !== undefined && ATTENTION_MOODS.has(facts.mood)) ||
    (facts.status != null && ATTENTION_STATUSES.has(facts.status))
  );
}

/**
 * How long an alert suppresses an identical one.
 *
 * A single 20-hour window governed both "Mum would like pizza" and "Mum fell", which is
 * the wrong trade in one of those two cases. A second fall within the same day is not
 * noise to be collapsed — it is arguably more urgent than the first, and suppressing it
 * produced a `notify.suppressed_duplicate` log line and nothing else.
 *
 * The window still has to exist: a retried call and two medication slots close together
 * otherwise produce separate identical texts, and alerts that read as noise get ignored
 * wholesale. Four hours is short enough that a genuinely recurring safety event gets
 * through on the same day, long enough to absorb a retry chain.
 */
export const DEDUPE_WINDOW_HOURS = {
  safety: 4,
  routine: 20,
} as const;

export type AlertSeverity = keyof typeof DEDUPE_WINDOW_HOURS;
