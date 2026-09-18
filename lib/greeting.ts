/**
 * The first thing anyone ever hears from this product.
 *
 * This single sentence decides whether there is a product at all for a given family, so it
 * lives in one place rather than being retyped wherever it's needed — a copy in the eval
 * suite drifting from the copy Vapi actually speaks would mean scoring a line no one is
 * ever read.
 *
 * Design notes, because the obvious edits here are the wrong ones:
 *
 * - It leads with the family member by name. That is the one fact that makes an unfamiliar
 *   voice safe to talk to, and it belongs before anything else. The previous version
 *   opened "This call may be recorded so your family can see a summary later" — call-centre
 *   boilerplate, delivered to precisely the demographic trained to hang up on unfamiliar
 *   voices asking for something, with an evasive-sounding "may be" on top.
 *
 * - "I keep a written record of our chats" is active, plain, and — since audio recording
 *   was switched off in Vapi (artifactPlan.recordingEnabled: false) — accurate. Audio is
 *   no longer retained; the transcript is, and a transcript is still a record of the
 *   conversation, so it is still disclosed. Saying "I record" would now overstate what
 *   happens, and "I take notes" would understate a verbatim transcript.
 *
 *   It is also *more* explicit than the language it replaced, not less: it cannot be
 *   misheard as the recitation people have learned to ignore. California (where this runs)
 *   is a two-party consent state — Penal Code §632 — so the consent has to be genuinely
 *   understood to exist at all, and a consent flow designed to slip past someone is not a
 *   grey area, it's the violation.
 *
 * - "Just say no if you'd rather not" stays. It reads like it would cost conversions and
 *   doesn't: someone who felt cornered into yes is guarded and agreeable on every call
 *   afterwards, which produces the cheerful, untrue answers the whole call exists to
 *   avoid — the same failure mode as pressuring them about a pill. Making refusal safe is
 *   what makes the yes worth having.
 */
/**
 * Version of the SPOKEN consent wording. Distinct from CONSENT_VERSION in lib/consent.ts,
 * which versions the SMS opt-in checkbox copy — logging that one against a verbal consent
 * pointed the record at the wrong document entirely, and would re-label call-consent
 * records whenever unrelated SMS copy changed. Bump this whenever consentGreeting changes.
 */
export const SPOKEN_CONSENT_VERSION = "2026-09-18.1";

export function consentGreeting(parentName: string, assistantName: string, caregiverName: string): string {
  return (
    `Hi ${parentName}, I'm ${assistantName} — ${caregiverName} asked me to check in with you each day. ` +
    `I keep a written record of our chats so I can send them a short summary afterwards. ` +
    `Is that alright with you? Just say no if you'd rather not.`
  );
}

/** Opening for every call after consent is on file — no consent question. */
export function returningGreeting(parentName: string, assistantName: string): string {
  return `Hi ${parentName}, it's ${assistantName} calling for your check-in. How are you feeling today?`;
}
