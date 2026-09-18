export interface Caregiver {
  id: string;
  email: string;
  name: string;
  phone: string;
  created_at: string;
}

export interface Parent {
  id: string;
  caregiver_id: string;
  name: string;
  phone: string;
  timezone: string;
  preferred_voice: string;
  consent_given_at: string | null;
  /** Set when they explicitly declined. Distinct from "not asked yet", which is both null. */
  consent_refused_at: string | null;
  /** Caregiver confirmed they told their parent to expect the calls. Advisory only — it
   *  is never treated as the parent's consent, which only Rosie can obtain on the call. */
  prewarm_confirmed_at: string | null;
  /** No call is placed before this instant, so the first one can be timed for when the
   *  parent is ready. */
  first_call_after: string | null;
  /** When check-ins were last explicitly resumed. Resume clears paused_until rather than
   *  moving it, so this is the only record that the gap was intentional. */
  resumed_at: string | null;
  /** When this parent's day was last successfully planned (0036). Not a health signal —
   *  lib/slots.ts uses it to tell a scheduler outage from a slot added after its deadline. */
  last_planned_at: string | null;
  /** Scheduler skips this parent until this instant; null means active. */
  paused_until: string | null;
  created_at: string;
}

export interface Medication {
  id: string;
  parent_id: string;
  name: string;
  dose: string | null;
  time_of_day: string;
  notes: string | null;
  /** How to recognize it by appearance/taste/location, e.g. "small blue tablet, in the left drawer". */
  description: string | null;
  active: boolean;
  /** Optional course date range (both YYYY-MM-DD, inclusive). Both null = repeats every day, no end. */
  start_date: string | null;
  end_date: string | null;
}

export interface Appointment {
  id: string;
  parent_id: string;
  title: string;
  starts_at: string;
  location: string | null;
  notes: string | null;
}

export type FamilyRole = "son" | "daughter" | "spouse" | "aide" | "other";

export interface FamilyContact {
  id: string;
  parent_id: string;
  name: string;
  phone: string;
  email: string | null;
  role: FamilyRole | null;
  notify_on_miss: boolean;
  notify_on_concern: boolean;
  sms_opt_in_confirmed: boolean;
}

export interface WatchItem {
  id: string;
  parent_id: string;
  /** The caregiver's own words, e.g. "left knee pain since her fall in June". */
  description: string;
  /** false: only alert if it sounds worse than usual. true: always alert when raised. */
  always_alert: boolean;
  created_at: string;
}

export interface EscalationRules {
  parent_id: string;
  retry_after_minutes: number;
  max_retries: number;
  concern_keywords: string[];
}

export interface Call {
  id: string;
  parent_id: string;
  scheduled_for: string;
  called_at: string | null;
  /** Stamped immediately before dialing, so a failure during/after the call can't erase
   *  the fact that we rang. The consent gate reads this; called_at means it was placed. */
  dial_attempted_at: string | null;
  /** Reaper bookkeeping only (0032): when a row stranded at 'scheduled' was last
   *  re-attempted. Never means the call connected — the reaper used to overload called_at
   *  for this, which showed the caregiver a check-in that never happened. */
  stale_redial_at: string | null;
  status: "scheduled" | "in_progress" | "completed" | "no_answer" | "failed" | null;
  vapi_call_id: string | null;
  retry_count: number;
  transcript: string | null;
  summary: string | null;
  meds_confirmed: Record<string, unknown> | null;
  concerns: string[] | null;
  /** Non-medical things they asked for, which Rosie promised to relay. */
  requests: string[] | null;
  /** Snapshot of the medication names actually due at call-creation time (see lib/dial.ts). */
  scheduled_meds: string[] | null;
  /** Claude's read of how they sounded, persisted so change-over-time analysis is possible. */
  mood: "good" | "okay" | "low" | "concerning" | "unknown" | null;
  created_at: string;
}

export interface Message {
  id: string;
  call_id: string;
  parent_id: string | null;
  /** Identifies "we already said this" for de-duplication — see lib/insights alertFingerprint. */
  fingerprint: string | null;
  /** Null once that family contact is removed from the setup form (ON DELETE SET NULL). */
  contact_id: string | null;
  /** Phone or email this actually went to, snapshotted so history survives contact removal. */
  recipient: string | null;
  body: string;
  sent_at: string;
  /** Provider message id — Twilio SID for SMS, SendGrid message id for email. */
  twilio_sid: string | null;
  /** Whether the provider accepted the send request — NOT whether it arrived. */
  status: "sent" | "failed";
  /** What the carrier actually did with it, via Twilio status callback. */
  delivery_status: "queued" | "sending" | "sent" | "delivered" | "undelivered" | "failed" | null;
  delivered_at: string | null;
  delivery_error: string | null;
  channel: "sms" | "email";
  error: string | null;
}

// Shape submitted by the /setup form (see app/setup/page.tsx and app/api/parents/route.ts)
export interface SetupFormPayload {
  caregiver: {
    name: string;
    phone: string;
  };
  parent: {
    name: string;
    phone: string;
    timezone: string;
    assistant_name: string;
  };
  medications: Array<{
    name: string;
    dose: string;
    time_of_day: string;
    notes: string;
    description: string;
    start_date: string;
    end_date: string;
  }>;
  appointments: Array<{
    title: string;
    starts_at: string;
    location: string;
    notes: string;
  }>;
  family_contacts: Array<{
    name: string;
    phone: string;
    email: string;
    role: FamilyRole;
    notify_on_miss: boolean;
    notify_on_concern: boolean;
    sms_opt_in_confirmed: boolean;
  }>;
  watch_items: Array<{
    description: string;
    always_alert: boolean;
  }>;
  rules: {
    retry_after_minutes: number;
    max_retries: number;
  };
}

/**
 * One materialised call in the day's queue (migration 0033).
 *
 * The scheduler used to re-derive this on every tick from medsDueNow plus a catch-up
 * constant plus a coverage window. Written down, "this call is due at X and stops making
 * sense at Y" is two columns and the derivations go away.
 */
export interface CallSlot {
  id: string;
  parent_id: string;
  due_at: string;
  expires_at: string;
  kind: "medication" | "appointment";
  med_names: string[];
  appointment_id: string | null;
  /** pending -> dispatched | expired | cancelled. One column, mutually exclusive. */
  state: "pending" | "dispatched" | "expired" | "cancelled";
  call_id: string | null;
  created_at: string;
  updated_at: string;
}
