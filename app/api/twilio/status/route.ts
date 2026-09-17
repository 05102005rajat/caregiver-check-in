import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Twilio delivery status callbacks.
 *
 * Authenticated by a shared secret in the query string rather than Twilio's
 * X-Twilio-Signature, because signature validation requires the account auth token and
 * this app deliberately authenticates with a scoped API key instead. Same pattern the
 * cron route already uses.
 *
 * Worst case for a forged request is a wrong delivery status on one message — visible to
 * the caregiver rather than silent — but it's gated regardless.
 */
const TERMINAL_FAILURES = new Set(["undelivered", "failed"]);

export async function POST(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");
  if (!secret || secret !== process.env.TWILIO_STATUS_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Twilio posts form-encoded, not JSON.
  const form = await request.formData().catch(() => null);
  const sid = form?.get("MessageSid")?.toString();
  const status = form?.get("MessageStatus")?.toString();
  const errorCode = form?.get("ErrorCode")?.toString() || null;

  if (!sid || !status) {
    return NextResponse.json({ error: "Missing MessageSid or MessageStatus" }, { status: 400 });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("messages")
    .update({
      delivery_status: status,
      delivery_error: errorCode,
      delivered_at: status === "delivered" ? new Date().toISOString() : null,
    })
    .eq("twilio_sid", sid)
    .select("id, parent_id")
    .maybeSingle();

  if (error) {
    log.error("twilio_status.update_failed", { twilio_sid: sid, status, err: error });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (!data) {
    // A callback for a message we have no record of isn't actionable, but it's worth
    // knowing about: it means sends are happening outside the path that records them.
    log.warn("twilio_status.unknown_message", { twilio_sid: sid, status });
    return NextResponse.json({ ok: true });
  }

  if (TERMINAL_FAILURES.has(status)) {
    log.error("twilio_status.not_delivered", { message_id: data.id, parent_id: data.parent_id, status, error_code: errorCode });
  } else {
    log.info("twilio_status.updated", { message_id: data.id, status, error_code: errorCode });
  }

  return NextResponse.json({ ok: true });
}
