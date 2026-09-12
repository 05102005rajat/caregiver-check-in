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
  role: FamilyRole | null;
  notify_on_miss: boolean;
  notify_on_concern: boolean;
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
  status: "scheduled" | "in_progress" | "completed" | "no_answer" | "failed" | null;
  vapi_call_id: string | null;
  retry_count: number;
  transcript: string | null;
  summary: string | null;
  meds_confirmed: Record<string, unknown> | null;
  concerns: string[] | null;
  /** Snapshot of the medication names actually due at call-creation time (see lib/dial.ts). */
  scheduled_meds: string[] | null;
  created_at: string;
}

export interface Message {
  id: string;
  call_id: string;
  contact_id: string;
  body: string;
  sent_at: string;
  twilio_sid: string | null;
  status: "sent" | "failed";
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
    role: FamilyRole;
    notify_on_miss: boolean;
    notify_on_concern: boolean;
  }>;
  rules: {
    retry_after_minutes: number;
    max_retries: number;
  };
}
