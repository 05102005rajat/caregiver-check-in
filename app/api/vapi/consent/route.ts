import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyFamilyContacts } from "@/lib/notify";
import { alertFingerprint } from "@/lib/insights";
import { log } from "@/lib/log";
import { CONSENT_VERSION } from "@/lib/consent";

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

  // Consent is a two-state machine — granted or refused — and the two states are mutually
  // exclusive. Writing them as two independent nullable columns, each guarded by "only if
  // the other is null", is what produced the same bug three times running:
  //
  //   * guarded on consent_given_at   -> an already-consented parent could not withdraw
  //   * guarded on consent_refused_at -> anyone who ever refused could never withdraw later,
  //                                      because nothing cleared consent_refused_at when
  //                                      they subsequently said yes
  //
  // Each fix closed one path and left the next one open. So: write the new state
  // unconditionally, always clearing the opposite field, and decide whether to notify by
  // comparing the state before and after — not by whether a guarded UPDATE happened to
  // match a row. A guard that silently matches nothing is indistinguishable from success,
  // which is precisely how a person asking to be left alone got ignored.
  const { data: prior, error: readError } = await db
    .from("parents")
    .select("consent_given_at, consent_refused_at")
    .eq("id", parentId)
    .maybeSingle();

  if (readError || !prior) {
    log.error("consent.prior_state_read_failed", { parent_id: parentId, err: readError });
    return NextResponse.json({ ok: false, result: "Sorry, something went wrong on our end." }, { status: 500 });
  }

  const priorState = prior.consent_given_at ? "given" : prior.consent_refused_at ? "refused" : "unasked";
  const nextState = consented ? "given" : "refused";
  const now = new Date().toISOString();

  // Repeating the same answer keeps the original timestamp — that is when consent was
  // actually given or refused, and it is the date shown to the caregiver and the one that
  // matters if anyone ever has to evidence it.
  const { error: writeError } = await db
    .from("parents")
    .update(
      consented
        ? { consent_given_at: prior.consent_given_at ?? now, consent_refused_at: null }
        : { consent_refused_at: prior.consent_refused_at ?? now, consent_given_at: null }
    )
    .eq("id", parentId);

  if (writeError) {
    // Never fall through to "nothing changed" on an error. That is what made a failed write
    // look like an already-handled refusal: nothing recorded, the scheduler still calling,
    // and a log line actively stating the refusal had already been dealt with.
    log.error("consent.persist_failed", { parent_id: parentId, consented, prior_state: priorState, err: writeError });
    return NextResponse.json({ ok: false, result: "Sorry, something went wrong on our end." }, { status: 500 });
  }

  // What we ASKED is the evidence worth keeping, and it is our own words rather than
  // theirs. Audio is not retained by design, and a refusal discards the transcript — so
  // without this line, evidence exists exactly where it is least needed (consented calls)
  // and nowhere it is most needed (a disputed refusal, or a consent the model misread).
  // Logging the wording version rather than storing the person's speech keeps the record
  // on our side of the conversation, which is the only side we have any business retaining
  // from someone who just declined.
  log.info("consent.recorded", {
    parent_id: parentId,
    from: priorState,
    to: nextState,
    consent_wording_version: CONSENT_VERSION,
    asked_via: "consentGreeting",
  });

  if (nextState === "refused" && priorState !== "refused") {
    const isWithdrawal = priorState === "given";
    const { data: parent } = await db.from("parents").select("name").eq("id", parentId).maybeSingle();
    const parentName = parent?.name ?? "Your parent";
    // Tell the caregiver, once per transition into refusal. Without this the only signal is
    // an absence of alerts, which is the same signal a healthy week produces.
    await notifyFamilyContacts(
      db,
      parentId,
      "notify_on_miss",
      activeCall.id,
      isWithdrawal
        ? `${parentName} asked us to stop the daily check-in calls, so we've stopped. They'd agreed before, so this is a change of mind rather than a first refusal — it may be worth a conversation. If they'd like to start again, use the button on your dashboard.`
        : `${parentName} declined the daily check-in calls when asked, so we've stopped calling. If you'd like to try again, it's worth speaking to them yourself first — then use the button on your dashboard.`,
      // Deliberately NOT `now`: notifyFamilyContacts dedupes on an exact fingerprint match, so a
      // millisecond-precision timestamp makes every refusal unique and disables dedupe entirely
      // — two concurrent record_consent invocations (which the old guarded write protected
      // against) would both notify. priorState keeps it stable per transition while still
      // letting a genuine later withdrawal through.
      { fingerprint: alertFingerprint(isWithdrawal ? "consent-withdrawn" : "consent-refused", [parentId, priorState]) }
    );
  }

  return NextResponse.json({ ok: true, result: consented ? "Consent recorded, thank you." : "Understood." });
}
