import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/twilio";
import type { FamilyContact } from "@/types/db";

type NotifyFlag = "notify_on_miss" | "notify_on_concern";

/** Texts every family contact for this parent with `flag` enabled, logging each send to `messages`. */
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
      await db.from("messages").insert({ call_id: callId, contact_id: contact.id, body, twilio_sid: sid, status: "sent" });
    } catch (err) {
      // Don't let a Twilio failure be silently equivalent to "the family was told" —
      // record it so it's visible (e.g. via Supabase) rather than only in server logs.
      console.error(`Failed to SMS family contact ${contact.id}`, err);
      await db.from("messages").insert({
        call_id: callId,
        contact_id: contact.id,
        body,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
