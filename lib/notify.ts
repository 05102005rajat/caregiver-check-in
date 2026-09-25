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
  const { data: recent, error: recentError } = await db
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
  if (recentError) {
    // Fails OPEN, deliberately and in the opposite direction to the opt-out check above: a
    // dedupe read that errors means we cannot prove the family already heard this, and for
    // a safety alert a duplicate text is much better than a silence we cannot detect.
    // Logged because the refactor runs this two or three times per alert, so a persistent
    // read failure shows up as the same message repeating rather than as an error anywhere.
    log.error("notify.dedupe_lookup_failed", { parent_id: parentId, recipient, fingerprint, err: recentError });
    return false;
  }
  return Boolean(recent);
}

/**
 * Whether we have already recorded that this recipient is opted out of this exact alert.
 * Separate from alreadyNotified because an opt-out is written as status 'failed', which
 * that check deliberately ignores — a failed send should be retried, a refusal to send
 * should not be re-recorded.
 */
async function alreadySuppressed(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  recipient: string,
  fingerprint: string | undefined,
  since: string
): Promise<boolean> {
  if (!fingerprint) return false;
  const { data, error } = await db
    .from("messages")
    .select("id")
    .eq("parent_id", parentId)
    .eq("fingerprint", fingerprint)
    .eq("recipient", recipient)
    .eq("status", "failed")
    .eq("delivery_status", "undelivered")
    .gte("sent_at", since)
    .limit(1)
    .maybeSingle();
  if (error) {
    // Fails open like the dedupe check: the cost is one duplicate "opted out" row, which is
    // bookkeeping noise, never a message to anyone.
    log.error("notify.suppression_lookup_failed", { parent_id: parentId, recipient, fingerprint, err: error });
    return false;
  }
  return Boolean(data);
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
): Promise<boolean> {
  // Honour opt-outs. The public form and every message promise that replying STOP or
  // asking us to remove a number takes effect — a promise with no mechanism behind it is
  // worse than not making it, and for SMS it's a compliance obligation, not a courtesy.
  const { data: optOut, error: optOutError } = await db
    .from("sms_opt_ins")
    .select("revoked_at")
    .eq("phone", phone)
    .not("revoked_at", "is", null)
    .limit(1)
    .maybeSingle();
  // Three states, not two. Failing closed on a read error is right — treating it as "no
  // opt-out on file" texts someone who sent STOP, which is a compliance breach rather than
  // a degraded experience. But the previous version folded the error into `suppressed`, and
  // the suppressed branch RECORDS a row saying `status:'failed'`,
  // `delivery_status:'undelivered'`, "Recipient has opted out" — which is exactly what
  // alreadySuppressed matches. So one transient read wrote a permanent-looking consent fact
  // that silenced every later path sharing that fingerprint for the whole dedupe window,
  // and told the operator the caregiver had opted out when they had not.
  //
  // Unknown now means: don't send, don't record anything, let the next attempt decide.
  if (optOutError) {
    log.error("notify.opt_out_lookup_failed", { parent_id: parentId, call_id: callId, recipient: phone, err: optOutError });
  }
  const optOutUnknown = Boolean(optOutError);
  const suppressed = Boolean(optOut);
  if (suppressed) {
    log.info("notify.suppressed_opt_out", { parent_id: parentId, call_id: callId, recipient: phone });
  }

  // Whether the SMS channel is DONE with this recipient — either a text just went, or one
  // for this same alert went earlier. Email is a fallback for neither case; see below.
  let smsSettled = false;

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

  // Reported to the caller, not just skipped. For a one-shot alert (a lapsed slot, whose
  // row is already claimed) there is no "next attempt", so this has to surface as a
  // degraded tick instead of passing for a delivered alert.
  let reached = true;
  if (optOutUnknown) {
    // Nothing written: no message, and no row that a later attempt would read as consent.
    reached = false;
  } else if (await alreadySuppressed(db, parentId, phone, fingerprint, since)) {
    // Already recorded as opted out for this exact alert. The household-wide early return
    // used to stop the whole function before reaching here; per-recipient dedupe only looks
    // at `sent`, so without this every path sharing a fingerprint (dial refusal, slot
    // expiry, stale reaper) inserted another "opted out" row for the same person and the
    // same slot, padding the operator's failed-notification view with duplicates of a
    // message that was never going to be sent.
    log.info("notify.suppressed_duplicate_optout", { parent_id: parentId, call_id: callId, fingerprint, recipient: phone });
  } else if (await alreadyNotified(db, parentId, phone, fingerprint, since)) {
    // Deliberately records nothing: a duplicate is the absence of a new message, not a new
    // event, and inserting a row for it would be a second `sent`-shaped fact about a text
    // that was never sent.
    // They were ALREADY TOLD, by text, about this exact alert. Not emailing them is the
    // entire point of the dedupe, and leaving this false was a real regression: the email
    // fallback below would then fire, because no email row exists for the first alert to
    // dedupe against. A suppressed text would have arrived as an email saying the same
    // thing — the duplicate this file was just changed to remove, on the other channel.
    smsSettled = true;
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
      smsSettled = true;
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

  // Email only when the text did NOT go out.
  //
  // Both channels used to fire for every alert, so one check-in arrived twice — a text and
  // an identical email — which is noise on a product whose entire premise is that a
  // notification means something. Email existed because SMS was blocked pending Twilio
  // toll-free verification; that came through, so the duplicate is now just the scaffolding
  // left standing.
  //
  // It stays as a fallback for the cases where the text never went: a Twilio failure, or a
  // recipient who opted out of texts. Opting out of SMS is not opting out of being told
  // their parent fell — the opt-out branch above deliberately records and continues.
  //
  // Stated precisely, because the comment used to claim more: `smsSettled` means Twilio
  // ACCEPTED the request, not that the carrier delivered it. A disconnected number or a
  // landline returns a SID and an `undelivered` callback minutes later, and nothing
  // re-enters this function when that lands — so that case gets no email. Covering it means
  // reacting to the delivery callback, which this does not do.
  if (smsSettled) {
    log.info("notify.email_skipped_sms_sent", { parent_id: parentId, call_id: callId, recipient: phone });
    return reached;
  }

  if (!email) return reached;
  if (await alreadyNotified(db, parentId, email, fingerprint, since)) {
    log.info("notify.suppressed_duplicate", { parent_id: parentId, call_id: callId, fingerprint, recipient: email });
    return reached;
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

  return reached;
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
/**
 * Returns false when a recipient was skipped for a reason that is NOT a decision — a failed
 * opt-out read, a failed contacts or parent read. Callers that get only one attempt must
 * treat that as a degraded tick rather than a delivered alert: expireLapsedSlots has already
 * claimed the slot and linked the calls row, so nothing re-reads it, and "let the next
 * attempt decide" has no next attempt there. Silent is the one outcome this must not have.
 */
export async function notifyFamilyContacts(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  flag: NotifyFlag,
  callId: string,
  body: string,
  options: {
    fingerprint?: string;
    dedupeWindowHours?: number;
    severity?: AlertSeverity;
    /**
     * Skip the family contacts and tell only the account holder.
     *
     * For the daily all-clear. A sibling who ticked "tell me about concerns" asked to hear
     * when something is wrong; a cheerful ping every morning is not that, and the surest way
     * to make a family mute this number is to send them something they did not ask for, 365
     * times a year. The person who set the service up is the one who wants to know it ran.
     */
    caregiverOnly?: boolean;
    /**
     * Never fall back to email for this alert, even when the text does not go.
     *
     * For the daily all-clear. The opt-out branch deliberately emails someone who replied
     * STOP, because opting out of texts is not opting out of hearing their parent fell — and
     * that reasoning does not survive a cheerful daily ping. Without this, replying STOP
     * converts the all-clear into an unsolicited daily EMAIL with nothing to turn it off,
     * which is exactly the "how a family mutes the channel the emergency will come from"
     * failure the note above is arguing against.
     */
    smsOnly?: boolean;
    /**
     * What the account holder receives instead of `body`, with its own fingerprint.
     *
     * For detail only the person who set the medications up can act on (a dose the call
     * could not confirm). Its own fingerprint so that detail counts as news for them without
     * making a repeated request or concern count as news for everyone else.
     */
    caregiverBody?: { body: string; fingerprint?: string };
  } = {}
): Promise<boolean> {
  // Don't tell the same family the same thing twice in a day. A retried call, two
  // medication slots close together, or a concern resurfacing on a later call all
  // otherwise produce separate identical alerts — and once alerts read as noise, the
  // one that actually matters gets ignored too. Fingerprint is built from the
  // structured facts by the caller, not the prose, so a reworded Claude summary of the
  // same underlying situation still counts as a duplicate.
  const { fingerprint, severity = "routine", caregiverOnly = false, smsOnly = false } = options;
  const dedupeWindowHours = options.dedupeWindowHours ?? DEDUPE_WINDOW_HOURS[severity];
  // Evaluated per recipient, down in sendAlert, rather than once for the whole household
  // here — see alreadyNotified for why suppressing everyone on one recipient's success is
  // how the account holder ended up never being told.
  const since = new Date(Date.now() - dedupeWindowHours * 60 * 60 * 1000).toISOString();

  const [{ data: contacts, error: contactsError }, { data: parentRow, error: parentError }] = await Promise.all([
    // Skipped under caregiverOnly. Querying anyway cost a round-trip per all-clear and, worse,
    // logged notify.contacts_lookup_failed at error level for a read whose outcome this
    // function has already decided is irrelevant — noise in the one log stream meant to matter.
    caregiverOnly
      ? Promise.resolve({ data: [] as FamilyContact[], error: null })
      : db.from("family_contacts").select("*").eq("parent_id", parentId).eq(flag, true),
    db.from("parents").select("caregiver_id").eq("id", parentId).single(),
  ]);
  // These two gate everything below them. A failed contacts read notifies no family
  // contact; a failed parents read drops the account holder as well, so the entire alert
  // evaporates with nothing logged — the shape the rest of this file was just audited for.
  if (contactsError) log.error("notify.contacts_lookup_failed", { parent_id: parentId, call_id: callId, err: contactsError });
  if (parentError) log.error("notify.parent_lookup_failed", { parent_id: parentId, call_id: callId, err: parentError });
  // With caregiverOnly the contacts list is deliberately unused, so a failed read of it says
  // nothing about whether this alert reached everyone it was meant to.
  let reachedEveryone = (caregiverOnly || !contactsError) && !parentError;

  // With a caregiver copy, the account holder's number is served by that copy alone. Dedupe is
  // per (recipient, fingerprint), and the two copies carry different fingerprints — so a
  // household whose caregiver is also listed as a family contact (production has exactly
  // that) would otherwise get the same text twice, once of each version. The caregiver copy
  // is a superset, so it is the one kept. Only under caregiverBody: every other alert keeps
  // relying on the shared fingerprint, which already collapses the pair.
  let caregiverPhone: string | null = null;
  if (options.caregiverBody && parentRow?.caregiver_id) {
    const { data: cg } = await db.from("caregivers").select("phone").eq("id", parentRow.caregiver_id).single();
    caregiverPhone = cg?.phone ?? null;
  }

  for (const contact of caregiverOnly ? [] : ((contacts ?? []) as FamilyContact[])) {
    if (caregiverPhone && contact.phone === caregiverPhone) continue;
    if (!(await sendAlert(db, parentId, callId, contact.id, contact.phone, smsOnly ? null : contact.email, body, fingerprint, since))) {
      reachedEveryone = false;
    }
  }

  if (parentRow?.caregiver_id) {
    const { data: caregiver, error: caregiverError } = await db
      .from("caregivers")
      .select("phone, email")
      .eq("id", parentRow.caregiver_id)
      .single();
    // The account holder is the one person guaranteed to be on every alert. A failed read
    // here drops them from it silently, which is the shape this whole branch is about.
    if (caregiverError) {
      log.error("notify.caregiver_lookup_failed", { parent_id: parentId, call_id: callId, err: caregiverError });
      reachedEveryone = false;
    }
    if (caregiver?.phone) {
      const own = options.caregiverBody;
      if (
        !(await sendAlert(
          db,
          parentId,
          callId,
          null,
          caregiver.phone,
          smsOnly ? null : (caregiver.email ?? null),
          own?.body ?? body,
          own ? own.fingerprint : fingerprint,
          since
        ))
      ) {
        reachedEveryone = false;
      }
    }
  }

  return reachedEveryone;
}
