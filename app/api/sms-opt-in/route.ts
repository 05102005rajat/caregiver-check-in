import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/consent";
import { toE164 } from "@/lib/phone";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Public SMS opt-in submissions.
 *
 * Deliberately unauthenticated: the point is that a family member consents for
 * themselves, rather than a caregiver asserting consent on their behalf. Writes only to
 * `sms_opt_ins`, which no caregiver or anonymous client can read.
 *
 * `consented` is optional by design — Twilio's guidance is explicit that submitting the
 * form must not require agreeing to texts.
 */
const bodySchema = z.object({
  name: z.string().trim().max(100).optional(),
  phone: z.string().trim().min(7).max(25),
  email: z.union([z.literal(""), z.string().trim().email()]).optional(),
  consented: z.boolean(),
  terms_accepted: z.boolean().optional(),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    // Name the failing field: reporting everything as a phone error left someone staring
    // at a valid phone number with no idea what to change.
    const field = parsed.error.issues[0]?.path[0];
    const message =
      field === "email" ? "Please enter a valid email address." : "Please enter a valid phone number.";
    return NextResponse.json({ error: message, field }, { status: 400 });
  }
  const { name, email, consented, terms_accepted } = parsed.data;

  // Stored E.164 so this record can actually be matched against the number Twilio sends
  // to. "(949) 555-1234" would never join to "+19495551234".
  const phone = toE164(parsed.data.phone);
  if (!phone) {
    return NextResponse.json({ error: "Please enter a valid phone number.", field: "phone" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const db = createAdminClient();

  // One row per number, so "is this person currently opted in?" has a single answer.
  // Re-submitting updates rather than stacking rows, and re-consenting clears a previous
  // revocation.
  const { error } = await db.from("sms_opt_ins").upsert(
    {
      phone,
      name: name || null,
      email: email || null,
      consented_at: consented ? now : null,
      // The wording is the server's, never the caller's — this endpoint is unauthenticated,
      // so trusting request text would let anyone fabricate a consent record.
      consent_text: consented ? CONSENT_TEXT : null,
      consent_version: consented ? CONSENT_VERSION : null,
      terms_accepted_at: terms_accepted ? now : null,
      revoked_at: consented ? null : now,
    },
    { onConflict: "phone" }
  );

  if (error) {
    log.error("sms_opt_in.insert_failed", { err: error });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  log.info("sms_opt_in.recorded", { consented });
  return NextResponse.json({ ok: true, consented });
}
