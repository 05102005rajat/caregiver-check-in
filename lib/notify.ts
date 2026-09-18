import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms, TwilioSendError, TWILIO_UNSUBSCRIBED } from "@/lib/twilio";
import { sendEmail } from "@/lib/email";
import { recordCarrierOptOut } from "@/lib/optout";
import { log } from "@/lib/log";
import type { FamilyContact } from "@/types/db";

type NotifyFlag = "notify_on_miss" | "notify_on_concern";

/**
 * Sends one alert by SMS (always) and email (if provided), logging each attempt to
 * `messages`. `contactId` is null for the caregiver themselves, who isn't a
 * `family_contacts` row.
 */
async function sendAlert(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  callId: string,
  contactId: string | null,
  phone: string,
  email: string | null,
  body: string,
  fingerprint?: string
) {
  // Honour opt-outs. The public form and every message promise that replying STOP or
  // asking us to remove a number takes effect — a promise with no mechanism behind it is
  // worse than not making it, and for SMS it's a compliance obligation, not a courtesy.
  const { data: optOut } = await db
    .from("sms_opt_ins")
    .select("revoked_at")
    .eq("phone", phone)
    .not("revoked_at", "is", null)
    .limit(1)
    .maybeSingle();
  const suppressed = Boolean(optOut);
  if (suppressed) {
    log.info("notify.suppressed_opt_out", { parent_id: parentId, call_id: callId, recipient: phone });
  }

  const common = { parent_id: parentId, call_id: callId, contact_id: contactId, fingerprint, body };
  // `recipient` is denormalized on purpose: contact_id goes null if that contact is
  // later removed from the setup form (ON DELETE SET NULL), and "who did we actually
  // notify" has to stay answerable after the fact for a care product.
  if (suppressed) {
    // Recorded rather than silently skipped, so the caregiver can see this person wasn't
    // contacted and why. Email is a separate channel and a separate consent — opting out
    // of texts shouldn't silently cut someone off from everything.
    await db.from("messages").insert({
      ...common,
      recipient: phone,
      status: "failed",
      channel: "sms",
      delivery_status: "undelivered",
      error: "Recipient has opted out of text messages",
    });
  } else {
    try {
      const sid = await sendSms(phone, body);
      await db.from("messages").insert({ ...common, recipient: phone, twilio_sid: sid, status: "sent", channel: "sms" });
      log.info("notify.sent", { parent_id: parentId, call_id: callId, channel: "sms", recipient: phone, twilio_sid: sid });
    } catch (err) {
      // A 21610 is the carrier telling us this person sent STOP. Record it so we stop
      // attempting (and stop burning a failed send on) every future alert — this is the
      // only path that may mark a number opted out; see lib/optout.ts.
      if (err instanceof TwilioSendError && err.code === TWILIO_UNSUBSCRIBED) {
        await recordCarrierOptOut(db, phone);
      }
      // Don't let a Twilio failure be silently equivalent to "the family was told" —
      // record it so it's visible (e.g. via Supabase) rather than only in server logs.
      log.error("notify.sms_failed", { parent_id: parentId, call_id: callId, contact_id: contactId, recipient: phone, err });
      await db.from("messages").insert({
        ...common,
        recipient: phone,
        status: "failed",
        channel: "sms",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!email) return;

  try {
    const messageId = await sendEmail(email, "Caregiver Check-In update", body);
    await db.from("messages").insert({ ...common, recipient: email, twilio_sid: messageId, status: "sent", channel: "email" });
  } catch (err) {
    log.error("notify.email_failed", { parent_id: parentId, call_id: callId, contact_id: contactId, recipient: email, err });
    await db.from("messages").insert({
      ...common,
      recipient: email,
      status: "failed",
      channel: "email",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Long enough to cover a full day of retries and repeated slots without suppressing a
// genuinely new day's alert about the same underlying issue.
const DEFAULT_DEDUPE_WINDOW_HOURS = 20;

/**
 * Notifies every family contact for this parent with `flag` enabled, plus always notifies
 * the caregiver themselves (their own number/email is first-party consent — they signed up
 * for and are actively using the service, unlike a family contact's number, which the
 * caregiver entered on that person's behalf and needs its own opt-in confirmation, see
 * family_contacts.sms_opt_in_confirmed). Email has no carrier compliance gate, so it's a
 * working channel even while SMS delivery is blocked pending Twilio toll-free verification
 * (see README "Monitoring"/known limitations).
 */
export async function notifyFamilyContacts(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  flag: NotifyFlag,
  callId: string,
  body: string,
  options: { fingerprint?: string; dedupeWindowHours?: number } = {}
) {
  // Don't tell the same family the same thing twice in a day. A retried call, two
  // medication slots close together, or a concern resurfacing on a later call all
  // otherwise produce separate identical alerts — and once alerts read as noise, the
  // one that actually matters gets ignored too. Fingerprint is built from the
  // structured facts by the caller, not the prose, so a reworded Claude summary of the
  // same underlying situation still counts as a duplicate.
  const { fingerprint, dedupeWindowHours = DEFAULT_DEDUPE_WINDOW_HOURS } = options;
  if (fingerprint) {
    const since = new Date(Date.now() - dedupeWindowHours * 60 * 60 * 1000).toISOString();
    const { data: recent } = await db
      .from("messages")
      .select("id")
      .eq("parent_id", parentId)
      .eq("fingerprint", fingerprint)
      .eq("status", "sent")
      .gte("sent_at", since)
      .limit(1)
      .maybeSingle();
    if (recent) {
      log.info("notify.suppressed_duplicate", { parent_id: parentId, call_id: callId, fingerprint });
      return;
    }
  }

  const [{ data: contacts }, { data: parentRow }] = await Promise.all([
    db.from("family_contacts").select("*").eq("parent_id", parentId).eq(flag, true),
    db.from("parents").select("caregiver_id").eq("id", parentId).single(),
  ]);

  for (const contact of (contacts ?? []) as FamilyContact[]) {
    await sendAlert(db, parentId, callId, contact.id, contact.phone, contact.email, body, fingerprint);
  }

  if (parentRow?.caregiver_id) {
    const { data: caregiver } = await db
      .from("caregivers")
      .select("phone, email")
      .eq("id", parentRow.caregiver_id)
      .single();
    if (caregiver?.phone) {
      await sendAlert(db, parentId, callId, null, caregiver.phone, caregiver.email ?? null, body, fingerprint);
    }
  }
}
