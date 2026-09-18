import { z } from "zod";
import { CALLING_HOURS_END, CALLING_HOURS_START } from "@/lib/callwindow";

const phoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "Must be E.164 format, e.g. +15551234567");
// Medication times are also *call* times, so they have to sit inside the hours we are
// willing to ring an elderly person (lib/callwindow.ts). Without this the form silently
// accepted 22:48 and the dialer — which now refuses outside the window — would never call
// about it: the caregiver configures a reminder that can never fire and is told nothing.
// Rejecting it here, where the message reaches them, is the only honest option.
const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:mm, 24-hour")
  .refine(
    (value) => {
      const hour = Number(value.slice(0, 2));
      return hour >= CALLING_HOURS_START && hour < CALLING_HOURS_END;
    },
    `Check-in calls only go out between ${CALLING_HOURS_START}:00 and ${CALLING_HOURS_END}:00 — pick a time in that range`
  );
const dateSchema = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")]);

// These all end up as input to an LLM prompt (system prompt variables, transcript
// analysis context) — bounded lengths keep a caregiver's free-form text from blowing up
// prompt size, not a security boundary by themselves.
const shortText = (max: number) => z.string().max(max);
const shortNonEmptyText = (max: number) => z.string().trim().min(1).max(max);

export const setupFormSchema = z.object({
  caregiver: z.object({
    name: shortNonEmptyText(100),
    phone: phoneSchema,
  }),
  parent: z.object({
    name: shortNonEmptyText(100),
    phone: phoneSchema,
    timezone: z.string().trim().min(1).max(100),
    assistant_name: shortNonEmptyText(50),
  }),
  medications: z
    .array(
      z
        .object({
          name: shortNonEmptyText(100),
          dose: shortText(50),
          time_of_day: timeOfDaySchema,
          notes: shortText(300),
          description: shortText(300),
          start_date: dateSchema,
          end_date: dateSchema,
        })
        .refine((m) => !m.start_date || !m.end_date || m.end_date >= m.start_date, {
          message: "End date must be on or after start date",
          path: ["end_date"],
        })
    )
    .max(10)
    .refine(
      (meds) => {
        const seen = new Set<string>();
        for (const m of meds) {
          const key = `${m.name.trim().toLowerCase()}|${m.time_of_day}`;
          if (seen.has(key)) return false;
          seen.add(key);
        }
        return true;
      },
      { message: "Duplicate medication name + time" }
    ),
  appointments: z
    .array(
      z.object({
        title: shortNonEmptyText(150),
        starts_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date/time"),
        location: shortText(150),
        notes: shortText(300),
      })
    )
    .max(10),
  family_contacts: z
    .array(
      z.object({
        name: shortNonEmptyText(100),
        phone: phoneSchema,
        email: z.union([z.literal(""), z.string().trim().email()]),
        role: z.enum(["son", "daughter", "spouse", "aide", "other"]),
        notify_on_miss: z.boolean(),
        notify_on_concern: z.boolean(),
        sms_opt_in_confirmed: z
          .boolean()
          .refine((v) => v === true, "Must confirm this contact agreed to receive text alerts before saving"),
      })
    )
    .max(4),
  watch_items: z
    .array(
      z.object({
        description: shortNonEmptyText(300),
        always_alert: z.boolean(),
      })
    )
    .max(10)
    // Defaulted so a client still running the previous bundle across a deploy doesn't get
    // a 400 with no field on screen to explain it, losing the whole form.
    .default([]),
  rules: z.object({
    // Bounded so the form cannot configure harassment. min(1)/max(10) permitted eleven
    // calls inside ten minutes to a confused elderly person, which nothing downstream
    // re-checked. 15 minutes is the shortest gap that is plausibly "they were in the
    // bathroom" rather than badgering.
    retry_after_minutes: z.number().int().min(15).max(240),
    max_retries: z.number().int().min(0).max(3),
  }),
});

export type ValidatedSetupForm = z.infer<typeof setupFormSchema>;

/**
 * Turns a schema failure into sentences a caregiver can act on.
 *
 * Every message in this file was written to be read by the person filling in the form —
 * "Check-in calls only go out between 8:00 and 21:00 — pick a time in that range" exists
 * precisely so a caregiver isn't left configuring a reminder that can never fire. None of
 * them reached anybody: the route returned them under `details` and the form rendered only
 * `error`, so all of this arrived on screen as the word "Invalid input", with no indication
 * of which of seven steps was wrong. Naming the row ("Medication 2") matters as much as the
 * message, since the offending field is usually one of several identical-looking ones.
 */
const FIELD_LABELS: Record<string, string> = {
  time_of_day: "time",
  start_date: "start date",
  end_date: "end date",
  starts_at: "date & time",
  sms_opt_in_confirmed: "text alert consent",
  assistant_name: "assistant name",
  notify_on_miss: "missed-call alerts",
  notify_on_concern: "concern alerts",
  retry_after_minutes: "retry gap",
  max_retries: "retry limit",
  always_alert: "always alert",
};

const SECTION_LABELS: Record<string, { one: string; many?: string }> = {
  caregiver: { one: "Your details" },
  parent: { one: "Your parent's details" },
  medications: { one: "Medications", many: "Medication" },
  appointments: { one: "Appointments", many: "Appointment" },
  family_contacts: { one: "Family contacts", many: "Contact" },
  watch_items: { one: "Things to ask about", many: "Watch item" },
  rules: { one: "Call settings" },
};

export function describeSetupIssues(error: z.ZodError): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const issue of error.issues) {
    const [head, ...rest] = issue.path.map((p) => String(p));
    const section = SECTION_LABELS[head];
    let label: string;
    if (!section) {
      label = head ? head.replace(/_/g, " ") : "";
    } else if (rest.length > 0 && /^\d+$/.test(rest[0])) {
      // An indexed row: "Medication 2 — time". Index is 0-based in the path and 1-based on
      // screen, because the caregiver is looking at a list that starts at one.
      const field = rest[1];
      label = `${section.many ?? section.one} ${Number(rest[0]) + 1}${field ? ` — ${FIELD_LABELS[field] ?? field.replace(/_/g, " ")}` : ""}`;
    } else {
      const field = rest[0];
      label = `${section.one}${field ? ` — ${FIELD_LABELS[field] ?? field.replace(/_/g, " ")}` : ""}`;
    }
    const line = label ? `${label}: ${issue.message}` : issue.message;
    // Two schema rules can reject the same field for the same reason; the caregiver only
    // needs telling once.
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
