import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/twilio";
import { sendEmail } from "@/lib/email";
import type { FamilyContact } from "@/types/db";

type NotifyFlag = "notify_on_miss" | "notify_on_concern";

/**
 * Notifies every family contact for this parent with `flag` enabled, logging each send to
 * `messages`. Sends by SMS always, plus email if the contact has one on file — email has no
 * carrier compliance gate, so it's a working channel even while SMS delivery is blocked
 * pending Twilio toll-free verification (see README "Monitoring"/known limitations).
 */
export async function notifyFamilyContacts(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  flag: NotifyFlag,
  callId: string,
  body: string
) {
  const { data: contacts } = await db.from("family_contacts").select("*").eq("parent_id", parentId).eq(flag, true);

  for (const contact of (contacts ?? []) as FamilyContact[]) {
    try {
      const sid = await sendSms(contact.phone, body);
      await db.from("messages").insert({ call_id: callId, contact_id: contact.id, body, twilio_sid: sid, status: "sent", channel: "sms" });
    } catch (err) {
      // Don't let a Twilio failure be silently equivalent to "the family was told" —
      // record it so it's visible (e.g. via Supabase) rather than only in server logs.
      console.error(`Failed to SMS family contact ${contact.id}`, err);
      await db.from("messages").insert({
        call_id: callId,
        contact_id: contact.id,
        body,
        status: "failed",
        channel: "sms",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!contact.email) continue;

    try {
      const messageId = await sendEmail(contact.email, "Caregiver Check-In update", body);
      await db.from("messages").insert({ call_id: callId, contact_id: contact.id, body, twilio_sid: messageId, status: "sent", channel: "email" });
    } catch (err) {
      console.error(`Failed to email family contact ${contact.id}`, err);
      await db.from("messages").insert({
        call_id: callId,
        contact_id: contact.id,
        body,
        status: "failed",
        channel: "email",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
