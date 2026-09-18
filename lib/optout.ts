import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

/**
 * Records that a number is opted out of SMS, from a carrier-confirmed signal (Twilio
 * error 21610 — the recipient texted STOP).
 *
 * This is deliberately the *only* way `revoked_at` gets set. The public opt-in form is
 * unauthenticated by design, so if it could revoke, anyone who knew a caregiver's phone
 * number could silently switch off every alert for that household — the one failure mode
 * this product cannot have. An opt-out therefore has to originate from the carrier, which
 * only happens if the person holding the handset actually sent STOP.
 *
 * Writes are last-write-wins and idempotent: re-recording an existing opt-out is a no-op,
 * so repeated 21610s from a backlog of queued alerts don't churn the row or move the
 * original revocation timestamp.
 */
export async function recordCarrierOptOut(
  db: ReturnType<typeof createAdminClient>,
  phone: string
): Promise<void> {
  const now = new Date().toISOString();

  // Only stamp rows that aren't already revoked, so the timestamp keeps meaning "when
  // they first opted out" rather than "the last time we tried and got blocked".
  const { data: updated, error: updateError } = await db
    .from("sms_opt_ins")
    .update({ revoked_at: now })
    .eq("phone", phone)
    .is("revoked_at", null)
    .select("phone")
    .maybeSingle();

  if (updateError) {
    log.error("optout.update_failed", { recipient: phone, err: updateError });
    return;
  }
  if (updated) {
    log.info("optout.recorded", { recipient: phone, source: "carrier" });
    return;
  }

  // No row to update: either this number never used the opt-in form (common — most
  // contacts are added by a caregiver), or it was already revoked. Insert covers the
  // first; a 23505 means the second, or a concurrent writer, and is not an error.
  const { error: insertError } = await db.from("sms_opt_ins").insert({ phone, revoked_at: now });
  if (insertError) {
    if (insertError.code !== "23505") {
      log.error("optout.insert_failed", { recipient: phone, err: insertError });
    }
    return;
  }
  log.info("optout.recorded", { recipient: phone, source: "carrier" });
}
