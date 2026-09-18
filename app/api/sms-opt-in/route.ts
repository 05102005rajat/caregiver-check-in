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

  // This endpoint must never be able to *stop* someone's alerts.
  //
  // It's unauthenticated and keyed on an attacker-supplied phone number, so any path here
  // that sets `revoked_at` would let anyone who knows a caregiver's number silently
  // suppress every alert for that household — the single worst failure this product has.
  // Opting out is therefore carrier-driven only (Twilio 21610 after a STOP reply), in
  // lib/optout.ts. Submitting this form without ticking the box means "no consent
  // recorded", which is not the same thing as "unsubscribe me", and is handled as such.
  let error;
  if (consented) {
    // An affirmative submission is allowed to refresh the record, including clearing a
    // prior revocation — that's a real re-opt-in by someone holding the phone. If the
    // number is still blocked carrier-side, Twilio returns 21610 on the next send and
    // lib/optout.ts re-records the opt-out, so a forged re-subscribe self-heals after at
    // most one blocked message rather than actually reaching anyone.
    ({ error } = await db.from("sms_opt_ins").upsert(
      {
        phone,
        name: name || null,
        email: email || null,
        consented_at: now,
        // The wording is the server's, never the caller's — this endpoint is
        // unauthenticated, so trusting request text would let anyone fabricate a consent
        // record.
        consent_text: CONSENT_TEXT,
        consent_version: CONSENT_VERSION,
        terms_accepted_at: terms_accepted ? now : null,
        revoked_at: null,
      },
      { onConflict: "phone" }
    ));
  } else {
    // Declining records the submission only if we have nothing for this number yet.
    // Upserting here would let an anonymous POST wipe an existing consent record's
    // evidence (consent text, version, timestamp) — which is both a compliance record and
    // the thing that proves we were allowed to text them. 23505 means a row already
    // exists, which is exactly the case we want to leave untouched.
    const { error: insertError } = await db
      .from("sms_opt_ins")
      .insert({ phone, name: name || null, email: email || null, terms_accepted_at: terms_accepted ? now : null });
    error = insertError?.code === "23505" ? null : insertError;
  }

  if (error) {
    log.error("sms_opt_in.insert_failed", { err: error });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  log.info("sms_opt_in.recorded", { consented });
  return NextResponse.json({ ok: true, consented });
}
