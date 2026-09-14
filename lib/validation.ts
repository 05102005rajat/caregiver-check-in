import { z } from "zod";

const phoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "Must be E.164 format, e.g. +15551234567");
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:mm, 24-hour");
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
      })
    )
    .max(4),
  rules: z.object({
    retry_after_minutes: z.number().int().min(1).max(1440),
    max_retries: z.number().int().min(0).max(10),
  }),
});

export type ValidatedSetupForm = z.infer<typeof setupFormSchema>;
