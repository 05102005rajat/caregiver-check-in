import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordCarrierOptOut } from "@/lib/optout";
import { TWILIO_UNSUBSCRIBED } from "@/lib/twilio";
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

/**
 * How far along the delivery lifecycle each status is. Twilio's callbacks are not ordered
 * — a `sent` can land after the `delivered` it preceded — and blindly writing whichever
 * arrives last let a late `sent` overwrite a confirmed delivery and null out
 * `delivered_at`, so the dashboard showed "not confirmed" for a message the carrier had
 * actually delivered. Only ever move forward.
 */
const STATUS_RANK: Record<string, number> = {
  queued: 1,
  accepted: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  // Terminal failures rank highest: they're the final word on a message and must never be
  // masked by a stale in-flight callback.
  undelivered: 5,
  failed: 5,
};

function rank(status: string): number {
  return STATUS_RANK[status.toLowerCase()] ?? 0;
}

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
  const { data: existing, error: readError } = await db
    .from("messages")
    .select("id, parent_id, recipient, delivery_status")
    .eq("twilio_sid", sid)
    .maybeSingle();

  if (readError) {
    log.error("twilio_status.read_failed", { twilio_sid: sid, status, err: readError });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (existing && rank(status) < rank(existing.delivery_status ?? "")) {
    log.info("twilio_status.ignored_out_of_order", {
      twilio_sid: sid,
      incoming: status,
      current: existing.delivery_status,
    });
    return NextResponse.json({ ok: true });
  }

  const { data, error } = await db
    .from("messages")
    .update({
      delivery_status: status,
      delivery_error: errorCode,
      // Only clear the delivery timestamp on a status that actually contradicts delivery;
      // an ordinary in-flight update must not erase it.
      ...(status === "delivered"
        ? { delivered_at: new Date().toISOString() }
        : TERMINAL_FAILURES.has(status)
          ? { delivered_at: null }
          : {}),
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
    // A message that failed because the recipient unsubscribed is the carrier confirming
    // an opt-out — the async counterpart to the 21610 thrown at send time. Record it so we
    // stop attempting future alerts to this number.
    if (errorCode === String(TWILIO_UNSUBSCRIBED) && existing?.recipient) {
      await recordCarrierOptOut(db, existing.recipient);
    }
    log.error("twilio_status.not_delivered", { message_id: data.id, parent_id: data.parent_id, status, error_code: errorCode });
  } else {
    log.info("twilio_status.updated", { message_id: data.id, status, error_code: errorCode });
  }

  return NextResponse.json({ ok: true });
}
