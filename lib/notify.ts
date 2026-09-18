import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms, TwilioSendError, TWILIO_UNSUBSCRIBED } from "@/lib/twilio";
import { sendEmail } from "@/lib/email";
import { recordCarrierOptOut } from "@/lib/optout";
import { log } from "@/lib/log";
import { DEDUPE_WINDOW_HOURS, type AlertSeverity } from "@/lib/alerting";
import type { FamilyContact } from "@/types/db";

type NotifyFlag = "notify_on_miss" | "notify_on_concern";

/**
 * Sends one alert by SMS (always) and email (if provided), logging each attempt to
 * `messages`. `contactId` is null for the caregiver themselves, who isn't a
 * `family_contacts` row.
 */
/**
 * Whether this exact recipient has already been told this exact thing inside the window.
 *
 * Per recipient, not per household. The check used to run once for everyone before any
 * message went out, so a fingerprint that reached the family contact suppressed it for the
 * caregiver too — and the case where that happens is precisely the case where it matters:
 * the contact's SMS succeeded, the caregiver's failed (carrier reject, opt-out, Twilio
 * error), and the next attempt found the contact's `sent` row and stayed quiet. The person
 * who never heard anything was the account holder, and nothing surfaced that they hadn't.
 */
async function alreadyNotified(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  recipient: string,
  fingerprint: string | undefined,
  since: string
): Promise<boolean> {
  if (!fingerprint) return false;
  // `status: 'sent'` only means Twilio accepted the request. delivery_status is the
  // carrier's verdict, and it exists precisely because "accepted" was being shown as
  // "family alerted" for messages that were then refused. Suppressing today's alert as a
  // duplicate of a message that came back `undelivered` means nobody is ever told —
  // the system has the data to know better and was not consulting it. A null
  // delivery_status (no callback yet) still counts: we have no evidence it failed.
  const { data: recent } = await db
    .from("messages")
    .select("id")
    .eq("parent_id", parentId)
    .eq("fingerprint", fingerprint)
    .eq("recipient", recipient)
    .eq("status", "sent")
    // NULL-safe on purpose. `NOT (delivery_status IN (...))` evaluates to NULL — i.e. no
    // match — for the 17-of-21 rows that have no callback yet, so the previous form
    // excluded almost every message and dedupe silently stopped suppressing anything.
    // The comment above said nulls still count; the query did the opposite.
    .or("delivery_status.is.null,delivery_status.not.in.(undelivered,failed)")
    .gte("sent_at", since)
    .limit(1)
    .maybeSingle();
  return Boolean(recent);
}

async function sendAlert(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  callId: string,
  contactId: string | null,
  phone: string,
  email: string | null,
  body: string,
  fingerprint: string | undefined,
  since: string
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
  // Every insert below is checked. A dropped `messages` row is not cosmetic: the dashboard
  // shows no alert for a call where the family *was* texted, the operator view's failed-
  // notification list is incomplete, and — worst — the fingerprint/sent_at dedupe lookup
  // finds nothing, so the identical alert re-sends on the next call inside the window.
  const recordMessage = async (row: Record<string, unknown>, channel: string) => {
    const { error } = await db.from("messages").insert(row);
    if (error) {
      log.error("notify.message_insert_failed", {
        parent_id: parentId,
        call_id: callId,
        channel,
        recipient: row.recipient,
        err: error,
      });
    }
  };

  if (await alreadyNotified(db, parentId, phone, fingerprint, since)) {
    // Deliberately records nothing: a duplicate is the absence of a new message, not a new
    // event, and inserting a row for it would be a second `sent`-shaped fact about a text
    // that was never sent.
    log.info("notify.suppressed_duplicate", { parent_id: parentId, call_id: callId, fingerprint, recipient: phone });
  } else if (suppressed) {
    // Recorded rather than silently skipped, so the caregiver can see this person wasn't
    // contacted and why. Email is a separate channel and a separate consent — opting out
    // of texts shouldn't silently cut someone off from everything.
    await recordMessage({
      ...common,
      recipient: phone,
      status: "failed",
      channel: "sms",
      delivery_status: "undelivered",
      error: "Recipient has opted out of text messages",
    }, "sms");
  } else {
    try {
      const sid = await sendSms(phone, body);
      await recordMessage({ ...common, recipient: phone, twilio_sid: sid, status: "sent", channel: "sms" }, "sms");
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
      await recordMessage({
        ...common,
        recipient: phone,
        status: "failed",
        channel: "sms",
        error: err instanceof Error ? err.message : String(err),
      }, "sms");
    }
  }

  if (!email) return;
  if (await alreadyNotified(db, parentId, email, fingerprint, since)) {
    log.info("notify.suppressed_duplicate", { parent_id: parentId, call_id: callId, fingerprint, recipient: email });
    return;
  }

  try {
    const messageId = await sendEmail(email, "Caregiver Check-In update", body);
    await recordMessage({ ...common, recipient: email, twilio_sid: messageId, status: "sent", channel: "email" }, "email");
  } catch (err) {
    log.error("notify.email_failed", { parent_id: parentId, call_id: callId, contact_id: contactId, recipient: email, err });
    await recordMessage({
      ...common,
      recipient: email,
      status: "failed",
      channel: "email",
      error: err instanceof Error ? err.message : String(err),
    }, "email");
  }
}

// Windows live in lib/alerting.ts alongside the attention rule they belong with.

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
  options: { fingerprint?: string; dedupeWindowHours?: number; severity?: AlertSeverity } = {}
) {
  // Don't tell the same family the same thing twice in a day. A retried call, two
  // medication slots close together, or a concern resurfacing on a later call all
  // otherwise produce separate identical alerts — and once alerts read as noise, the
  // one that actually matters gets ignored too. Fingerprint is built from the
  // structured facts by the caller, not the prose, so a reworded Claude summary of the
  // same underlying situation still counts as a duplicate.
  const { fingerprint, severity = "routine" } = options;
  const dedupeWindowHours = options.dedupeWindowHours ?? DEDUPE_WINDOW_HOURS[severity];
  // Evaluated per recipient, down in sendAlert, rather than once for the whole household
  // here — see alreadyNotified for why suppressing everyone on one recipient's success is
  // how the account holder ended up never being told.
  const since = new Date(Date.now() - dedupeWindowHours * 60 * 60 * 1000).toISOString();

  const [{ data: contacts }, { data: parentRow }] = await Promise.all([
    db.from("family_contacts").select("*").eq("parent_id", parentId).eq(flag, true),
    db.from("parents").select("caregiver_id").eq("id", parentId).single(),
  ]);

  for (const contact of (contacts ?? []) as FamilyContact[]) {
    await sendAlert(db, parentId, callId, contact.id, contact.phone, contact.email, body, fingerprint, since);
  }

  if (parentRow?.caregiver_id) {
    const { data: caregiver } = await db
      .from("caregivers")
      .select("phone, email")
      .eq("id", parentRow.caregiver_id)
      .single();
    if (caregiver?.phone) {
      await sendAlert(db, parentId, callId, null, caregiver.phone, caregiver.email ?? null, body, fingerprint, since);
    }
  }
}
