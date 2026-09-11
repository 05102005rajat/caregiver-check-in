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
