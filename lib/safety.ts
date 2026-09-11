/**
 * Deterministic backstop for LLM-based concern detection. Runs independently of Claude's
 * classification so a Claude outage or misclassification doesn't silently drop a genuine
 * emergency mention (e.g. "I fell down and I'm having chest pain").
 */
export function scanForConcernKeywords(transcript: string, keywords: string[]): string[] {
  const lower = transcript.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}
