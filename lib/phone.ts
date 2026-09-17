/** Shared E.164 handling, so numbers collected anywhere are comparable everywhere. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Best-effort normalization of what people actually type — "(949) 555-1234" — into the
 * E.164 form Twilio uses. Returns null when it can't be trusted.
 *
 * Without this, a consent record stored as "(949) 555-1234" can never be matched to the
 * "+19495551234" that actually receives the message, which makes the record useless in
 * precisely the dispute it exists to settle.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (E164.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");

  // A leading "+" means the caller already gave a fully-qualified international number,
  // so US assumptions must not be applied to it. Without this guard "+0123456789" was
  // silently rewritten to the US number "+10123456789" — a different person entirely.
  if (trimmed.startsWith("+")) return E164.test(`+${digits}`) ? `+${digits}` : null;

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
