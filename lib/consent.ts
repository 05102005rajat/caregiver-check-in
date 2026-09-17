/**
 * Canonical SMS consent wording, versioned.
 *
 * Lives server-side and is written to the record from here — never from the request body.
 * The opt-in route is deliberately unauthenticated, so accepting client-supplied consent
 * text would let anyone POST a fabricated record ("I agreed to anything") against any
 * phone number, which destroys the evidentiary value this record exists for.
 *
 * Bump the version whenever the wording changes, so old rows keep meaning what they meant.
 */
export const CONSENT_VERSION = "2026-09-17.1";

export const CONSENT_TEXT =
  "By checking this box, I agree to receive informational SMS text messages from Caregiver Check-In about my family member's daily check-in calls — sent only when a check-in is missed or a concern is detected, typically no more than a few messages per week. Message and data rates may apply. Reply HELP for help or STOP to unsubscribe at any time.";
