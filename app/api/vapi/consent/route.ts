import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyFamilyContacts } from "@/lib/notify";
import { alertFingerprint } from "@/lib/insights";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const consentBodySchema = z.object({
  parent_id: z.string().min(1),
  consented: z.boolean(),
});

/**
 * Target of the record_consent Tool (Vapi "API Request" type — a direct HTTP call from
 * Vapi with a body it builds, not the message-envelope format the main /api/vapi/webhook
 * route handles). parent_id arrives as a Static Body Field templated from the call's
 * variableValues ({{parent_id}}, set in lib/dial.ts); consented is the argument the
 * assistant fills in based on the conversation.
 */
export async function POST(request: Request) {
  const secretHeader = request.headers.get("x-webhook-secret");
  if (secretHeader !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await request.json();
  const parsed = consentBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const { parent_id: parentId, consented } = parsed.data;

  const db = createAdminClient();

  // The webhook secret alone would otherwise be a standing credential to set consent for
  // any parent_id. Requiring a currently-active call for that parent narrows a leaked
  // secret's blast radius to "during a call already in progress," not "at any time."
  // 'scheduled' counts as active too. A call whose post-dial bookkeeping write failed stays
  // 'scheduled' while genuinely ringing, and rejecting consent for it was expensive out of
  // all proportion: a parent who clearly said yes had their consent dropped, after which
  // the end-of-call webhook saw consent_given_at null and destroyed the transcript and
  // summary, and the cron gate blocked every future call — three irreversible outcomes from
  // one lost write.
  const { data: activeCall } = await db
    .from("calls")
    .select("id")
    .eq("parent_id", parentId)
    .in("status", ["in_progress", "scheduled"])
    .limit(1)
    .maybeSingle();
  if (!activeCall) {
    // Logged at error, and distinctly: the consequences above are silent and permanent, and
    // the only other trace is webhook.transcript_discarded_no_consent — which is exactly
    // what a genuine refusal looks like. Without this, a dropped yes is indistinguishable
    // from a real no.
    log.error("consent.no_active_call", { parent_id: parentId, consented });
    return NextResponse.json({ error: "No active call for this parent" }, { status: 409 });
  }

  if (consented) {
    // Don't clobber an existing timestamp (e.g. a duplicate tool invocation).
    const { error } = await db
      .from("parents")
      .update({ consent_given_at: new Date().toISOString() })
      .eq("id", parentId)
      .is("consent_given_at", null);
    if (error) {
      console.error(`Failed to persist consent for parent ${parentId}`, error);
      return NextResponse.json(
        { ok: false, result: "Sorry, something went wrong on our end — could you say that again?" },
        { status: 500 }
      );
    }
  } else {
    // A refusal used to write nothing at all, which made it indistinguishable from "hasn't
    // been asked yet" and had two bad consequences: the retry path re-dialled the same day,
    // moments after Rosie promised she wouldn't ring again; and the caregiver was never
    // told, so the scheduler simply went quiet — which in a product built on "no news is
    // good news" reads exactly like everything working.
    const { error } = await db
      .from("parents")
      .update({ consent_refused_at: new Date().toISOString() })
      .eq("id", parentId)
      .is("consent_given_at", null)
      .is("consent_refused_at", null);
    if (error) {
      // Don't fail the tool call: making Rosie apologise and re-ask would press someone who
      // has just declined, which is the one thing the refusal path must never do.
      log.error("consent.persist_refusal_failed", { parent_id: parentId, err: error });
    }

    // Tell the caregiver their parent said no, once. Without this the only signal is an
    // absence of alerts, which is the same signal a healthy week produces.
    const { data: parent } = await db.from("parents").select("name").eq("id", parentId).maybeSingle();
    const parentName = parent?.name ?? "Your parent";
    await notifyFamilyContacts(
      db,
      parentId,
      "notify_on_miss",
      activeCall.id,
      `${parentName} declined the daily check-in calls when asked for permission to record, so we've stopped calling. If you'd like to try again, it's worth speaking to them yourself first — then use the test call button.`,
      { fingerprint: alertFingerprint("consent-refused", [parentId]) }
    );
  }

  return NextResponse.json({ ok: true, result: consented ? "Consent recorded, thank you." : "Understood." });
}
