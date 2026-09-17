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
  return keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}\\b`, "i").test(transcript));
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
  return /^\s*(user|customer|human)\s*:/im.test(transcript);
}
