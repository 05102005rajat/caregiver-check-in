import { z } from "zod";

const phoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "Must be E.164 format, e.g. +15551234567");
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:mm, 24-hour");

export const setupFormSchema = z.object({
  caregiver: z.object({
    name: z.string().trim().min(1),
    phone: phoneSchema,
  }),
  parent: z.object({
    name: z.string().trim().min(1),
    phone: phoneSchema,
    timezone: z.string().trim().min(1),
    assistant_name: z.string().trim().min(1),
  }),
  medications: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        dose: z.string(),
        time_of_day: timeOfDaySchema,
        notes: z.string(),
        description: z.string(),
      })
    )
    .max(10),
  appointments: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        starts_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date/time"),
        location: z.string(),
        notes: z.string(),
      })
    )
    .max(10),
  family_contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        phone: phoneSchema,
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
