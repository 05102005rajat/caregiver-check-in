/** Fallback list when a parent has no custom concern_keywords configured. */
export const DEFAULT_CONCERN_KEYWORDS = ["fall", "fell", "dizzy", "pain", "chest", "breath", "confused", "scared"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic backstop for LLM-based concern detection. Runs independently of Claude's
 * classification so a Claude outage or misclassification doesn't silently drop a genuine
 * emergency mention (e.g. "I fell down and I'm having chest pain").
 *
 * Word-boundary matching (not substring) so "pain" doesn't match "painting". This still
 * can't disambiguate meaning within a word/phrase — "chest" matches both "chest pain" and
 * "chest of drawers" equally, and there's no negation awareness ("I didn't fall" still
 * matches "fall"). That's a known limitation: a real risk classifier needs more than a
 * keyword list, but this is a deliberately simple backstop, not the whole safety system.
 */
export function scanForConcernKeywords(transcript: string, keywords: string[]): string[] {
  return keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}\\b`, "i").test(parentTurnsOnly(transcript)));
}

/**
 * Only the parent's own words.
 *
 * The scan used to run over the whole transcript, including the assistant's turns — so
 * Rosie saying "I'll let your family know about that fall" was itself enough to trip the
 * "fall" keyword. Watch items made that fatal rather than merely noisy: their text is
 * injected into Rosie's prompt, so for a watch item like "left knee pain since her fall
 * in June" she says the words "pain" and "fall" out loud every single morning, tripping
 * the backstop and texting the family daily — the exact alert fatigue watch items exist
 * to remove, and it would have bypassed the LLM suppression entirely.
 */
/**
 * Whether the transcript uses speaker labels we recognise.
 *
 * Everything below depends on this and nothing checked it. The two failure modes point in
 * opposite directions and would arrive together: parentTurnsOnly falls back to scanning
 * the whole transcript (daily false alerts), while hasParentResponse returns false for
 * every call ("Parent didn't respond" on every check-in). Neither raises an error, so the
 * first signal would be a caregiver asking why the texts stopped making sense.
 *
 * Callers should log loudly when this is false for a non-empty transcript — it means the
 * provider changed something and both backstops are now degraded.
 */
export function hasRecognisableSpeakerLabels(transcript: string): boolean {
  return SPEAKER_LINE.test(transcript);
}

/** Matches a parent/customer turn. Real Vapi transcripts use "User:" (and "AI:" for Rosie). */
const SPEAKER_LINE = /^\s*(user|customer|human)\s*:/im;

function parentTurnsOnly(transcript: string): string {
  const lines = transcript.split("\n");
  const parentLines = lines.filter((line) => /^\s*(user|customer|human)\s*:/i.test(line));
  // If the transcript doesn't use recognizable speaker labels, scanning everything is the
  // safe failure: over-reporting a concern beats missing one.
  return parentLines.length > 0 ? parentLines.join("\n") : transcript;
}

/**
 * Whether the parent actually said anything at all.
 *
 * A call where they answer and immediately hang up produces a transcript containing only
 * the assistant's greeting. That is NOT a healthy check-in — nobody confirmed a
 * medication and nobody confirmed they're okay — but it also isn't a no-answer, so it
 * lands as "completed" and looks fine.
 *
 * The evaluation set (evals/cases.ts, case `hangup-no-content`) showed Claude flags this
 * only about half the time, which is exactly the kind of judgement that shouldn't be left
 * to a model: a family silently never hearing that their parent hung up is the failure
 * this product exists to prevent. Determined structurally instead.
 */
export function hasParentResponse(transcript: string): boolean {
  return SPEAKER_LINE.test(transcript);
}
