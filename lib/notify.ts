import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/twilio";
import { sendEmail } from "@/lib/email";
import type { FamilyContact } from "@/types/db";

type NotifyFlag = "notify_on_miss" | "notify_on_concern";

/**
 * Sends one alert by SMS (always) and email (if provided), logging each attempt to
 * `messages`. `contactId` is null for the caregiver themselves, who isn't a
 * `family_contacts` row.
 */
async function sendAlert(
  db: ReturnType<typeof createAdminClient>,
  callId: string,
  contactId: string | null,
  phone: string,
  email: string | null,
  body: string
) {
  try {
    const sid = await sendSms(phone, body);
    await db.from("messages").insert({ call_id: callId, contact_id: contactId, body, twilio_sid: sid, status: "sent", channel: "sms" });
  } catch (err) {
    // Don't let a Twilio failure be silently equivalent to "the family was told" —
    // record it so it's visible (e.g. via Supabase) rather than only in server logs.
    console.error(`Failed to SMS ${contactId ?? "caregiver"}`, err);
    await db.from("messages").insert({
      call_id: callId,
      contact_id: contactId,
      body,
      status: "failed",
      channel: "sms",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!email) return;

  try {
    const messageId = await sendEmail(email, "Caregiver Check-In update", body);
    await db.from("messages").insert({ call_id: callId, contact_id: contactId, body, twilio_sid: messageId, status: "sent", channel: "email" });
  } catch (err) {
    console.error(`Failed to email ${contactId ?? "caregiver"}`, err);
    await db.from("messages").insert({
      call_id: callId,
      contact_id: contactId,
      body,
      status: "failed",
      channel: "email",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
  body: string
) {
  const [{ data: contacts }, { data: parentRow }] = await Promise.all([
    db.from("family_contacts").select("*").eq("parent_id", parentId).eq(flag, true),
    db.from("parents").select("caregiver_id").eq("id", parentId).single(),
  ]);

  for (const contact of (contacts ?? []) as FamilyContact[]) {
    await sendAlert(db, callId, contact.id, contact.phone, contact.email, body);
  }

  if (parentRow?.caregiver_id) {
    const { data: caregiver } = await db
      .from("caregivers")
      .select("phone, email")
      .eq("id", parentRow.caregiver_id)
      .single();
    if (caregiver?.phone) {
      await sendAlert(db, callId, null, caregiver.phone, caregiver.email ?? null, body);
    }
  }
}
