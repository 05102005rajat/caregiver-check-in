/**
 * Probe households must never reach SendGrid. Import this FIRST in every harness.
 *
 * `notifyFamilyContacts` always alerts the account holder on BOTH channels, and every
 * throwaway caregiver is created with an `@example.invalid` address. SendGrid accepts each
 * request, bills a credit, and only then blocks it as invalid — 107 of them in a single day
 * of review rounds, which exhausted the account and took the live email channel down with
 * it. The product was fine; the verification code spent the budget.
 *
 * HANDOVER's non-routable `+1202555xxxx` rule has no email equivalent. There is no address
 * that is free to attempt, and `caregivers.email` is `unique not null`, so the two obvious
 * fixes — null it, or blank it — are both unavailable (blank collides the moment a suite
 * creates a second caregiver, which security/isolation.ts does).
 *
 * So the send is stopped at the credential instead. `lib/email.ts` reads the key through
 * `requireEnv` at call time, which throws on an empty value, and `sendAlert` already wraps
 * `sendEmail` in try/catch and records a `status: 'failed'` row. No HTTP request leaves the
 * machine, and no PRODUCT code changed.
 *
 * Assertions did change, and an earlier version of this comment wrongly said none had. A
 * `failed` email row is now written on every alert, which silently satisfied any assertion
 * that counted `messages` without filtering by channel — including the headline "TELLS THE
 * FAMILY" check in two of the three suites. Both had to be narrowed to `channel = 'sms'`
 * before they meant anything again; see the bullet below.
 *
 * What that costs, stated honestly, because an earlier version of this comment claimed it
 * cost nothing:
 *
 *   - Still covered: the email branch is still entered, `sendEmail` is still called, and the
 *     failure is still recorded as a `messages` row. The SMS channel is untouched, and SMS
 *     is what every dedupe assertion in these suites actually exercises.
 *   - Watch for this in the harnesses themselves. Because a `failed` email row is now
 *     written on EVERY alert, any assertion that counts `messages` without filtering is
 *     satisfied by that row alone — it passes with the SMS path deleted outright. Three
 *     review rounds each found another instance I had missed while claiming the audit was
 *     complete, so both harnesses now funnel every POSITIVE count through one helper
 *     (`deliveredSms` in queue.ts, `deliveredFor` in refusal.ts) that requires
 *     `channel = 'sms'` AND `status = 'sent'` — delivered, not merely attempted. Add new
 *     "the family was told" assertions through those helpers, never with an ad-hoc query.
 *     The NEGATIVE `=== 0` controls deliberately stay unfiltered: there, any message on any
 *     channel in any state must fail them.
 *   - NOT covered, by construction: email de-duplication. `alreadyNotified` matches on
 *     `status = 'sent'`, so a row recorded as `failed` can never suppress a later one — the
 *     email duplicate-suppression branch is now unreachable in every suite, and
 *     security/refusal.ts's "does not tell anyone twice" check counts only `sent` rows, so
 *     it no longer sees the email channel at all. A regression that emailed a caregiver
 *     twice for one fingerprint would pass.
 *
 * That was already true in practice while the account's credits were exhausted and every
 * send 401'd. The difference is that it is now permanent and deliberate, which is exactly
 * the kind of thing that has to be written down rather than discovered later: an untested
 * path that looks tested is the shape HANDOVER catalogues nine times over.
 *
 * Deliberately NOT done for Twilio: the suites assert on delivered SMS rows, and the real
 * notify path reaching a real provider is the thing HANDOVER credits with catching bugs
 * that reading code did not. See the note in HANDOVER on what probe SMS actually costs.
 */
import { requireEnv } from "@/lib/env";

const SUPPRESSED = "SENDGRID_API_KEY";

if (process.env[SUPPRESSED]) {
  delete process.env[SUPPRESSED];
}

// Assert the MECHANISM, not the assignment. `if (process.env.X) delete process.env.X` and
// then `if (process.env.X) throw` is a tautology — the throw is unreachable in Node, so it
// proved nothing while reading as a safety net. What actually has to hold is that
// lib/email.ts cannot obtain a key, and it obtains one through requireEnv, so that is what
// gets exercised: a future requireEnv that returns a default, or reads from somewhere else,
// breaks this loudly instead of silently billing the account on the next suite run.
//
// Deliberately not calling sendEmail itself: if suppression were broken, the assertion would
// send the email it exists to prevent.
try {
  requireEnv(SUPPRESSED);
  throw new Error(`no-email: ${SUPPRESSED} is still resolvable; refusing to run and bill real sends`);
} catch (err) {
  if (!(err instanceof Error) || !err.message.includes("Missing required environment variable")) throw err;
}

export const EMAIL_SUPPRESSED = true;
