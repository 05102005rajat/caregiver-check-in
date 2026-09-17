import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Public SMS opt-in submissions.
 *
 * Deliberately unauthenticated: the whole point is that a family member can consent for
 * themselves, rather than a caregiver asserting consent on their behalf. Writes only to
 * `sms_opt_ins`, which no caregiver can read, so the worst a spammer achieves is junk
 * rows in a table nobody reads.
 *
 * `consented` is optional by design — Twilio's guidance is explicit that submitting the
 * form must not require agreeing to texts.
 */
const bodySchema = z.object({
  name: z.string().trim().max(100).optional(),
  phone: z.string().trim().min(7).max(20),
  email: z.union([z.literal(""), z.string().trim().email()]).optional(),
  consented: z.boolean(),
  consent_text: z.string().max(1000),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please enter a valid phone number." }, { status: 400 });
  }
  const { name, phone, email, consented, consent_text } = parsed.data;

  const db = createAdminClient();
  const { error } = await db.from("sms_opt_ins").insert({
    phone,
    name: name || null,
    email: email || null,
    consented_at: consented ? new Date().toISOString() : null,
    // Only stored when they actually agreed — recording the wording against someone who
    // declined would misrepresent what happened.
    consent_text: consented ? consent_text : null,
  });

  if (error) {
    log.error("sms_opt_in.insert_failed", { err: error });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  log.info("sms_opt_in.recorded", { consented });
  return NextResponse.json({ ok: true, consented });
}
