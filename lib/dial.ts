import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { triggerVapiCall } from "@/lib/vapi";
import { formatAppointments, formatMeds } from "@/lib/format";
import type { Appointment, Medication, Parent } from "@/types/db";

/** Fires the actual Vapi call and records the outcome on an already-created `calls` row. */
export async function dialAndRecord(
  db: ReturnType<typeof createAdminClient>,
  callId: string,
  parent: Parent,
  caregiverName: string,
  medsDue: Medication[],
  todaysAppointments: Appointment[]
) {
  // Folds the consent ask into the opening line itself on a first call, instead of a
  // separate scripted greeting ("how are you feeling?") followed by a second, jarring
  // switch into the consent question — cuts one full back-and-forth out of the call.
  const firstMessage = parent.consent_given_at
    ? undefined
    : `Hi ${parent.name}, it's ${parent.preferred_voice} calling for your check-in. This call may be recorded so your family can see a summary later — is that okay?`;

  let vapiCall;
  try {
    vapiCall = await triggerVapiCall({
      toNumber: parent.phone,
      firstMessage,
      variableValues: {
        // Referenced by the record_consent Tool's Static Body Field ({{parent_id}}) so the
        // consent webhook knows which parent to update without depending on Vapi's call id.
        parent_id: parent.id,
        parent_name: parent.name,
        assistant_name: parent.preferred_voice,
        meds_due: formatMeds(medsDue),
        appointments_today: formatAppointments(todaysAppointments),
        family_setup_by: caregiverName,
        // Tells the assistant whether to ask the consent question this call (spec
        // section 8: ask on the first call, and any call since where it's still unset;
        // never re-ask once consent_given_at is set).
        consent_already_given: parent.consent_given_at ? "true" : "false",
      },
      // Correlation fallback: if the update below ever fails to persist vapi_call_id,
      // the webhook can still find this row via metadata.internal_call_id instead of
      // silently dropping the call's result (see app/api/vapi/webhook/route.ts).
      metadata: { internal_call_id: callId },
    });
  } catch (err) {
    // A transient Vapi-side rejection (network blip, 5xx) is not the same as "the person
    // didn't answer" — but treating it as terminal 'failed' had the same practical effect:
    // 'failed' rows are invisible to processRetries (which only ever queries status=
    // 'no_answer'), so a single transient API error either burned a retry attempt with no
    // real signal, or — on the very first dial — skipped the entire retry budget outright.
    // Routing this into the same no_answer/retry_count pipeline as a real no-answer means
    // it gets the same number of chances before genuinely giving up and alerting family.
    log.error("dial.trigger_failed", { call_id: callId, parent_id: parent.id, err });
    await db.from("calls").update({ status: "no_answer", called_at: new Date().toISOString() }).eq("id", callId);
    return;
  }

  log.info("dial.placed", { call_id: callId, parent_id: parent.id, vapi_call_id: vapiCall.id, meds: medsDue.length });

  const { error } = await db
    .from("calls")
    .update({ status: "in_progress", called_at: new Date().toISOString(), vapi_call_id: vapiCall.id })
    .eq("id", callId);
  if (error) {
    // The call was actually placed — don't mark this 'failed', that would misreport a
    // successful dial and orphan the row from the webhook's vapi_call_id lookup for no reason
    // beyond our own bookkeeping hiccup. Leave status as-is and just log for investigation.
    log.error("dial.persist_vapi_id_failed", { call_id: callId, parent_id: parent.id, vapi_call_id: vapiCall.id, err: error });
  }
}

/** Creates a calls row for `scheduledFor` and dials, skipping if that exact slot already exists. */
export async function scheduleAndDial(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  medsForSlot: Medication[],
  todaysAppointments: Appointment[],
  scheduledFor: Date
): Promise<boolean> {
  // calls has a unique (parent_id, scheduled_for) constraint: this is the idempotency
  // guard against a cron tick (or an overlapping manual trigger) dialing twice for one slot.
  const { data: callRow, error: insertError } = await db
    .from("calls")
    .insert({
      parent_id: parent.id,
      scheduled_for: scheduledFor.toISOString(),
      status: "scheduled",
      // Snapshot at creation time so later analysis (and any future caregiver edits to
      // medications) can't retroactively change what this specific call was actually for.
      scheduled_meds: medsForSlot.map((m) => m.name),
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code !== "23505") console.error("Failed to create calls row", insertError);
    return false; // already scheduled this slot, or a real error either way nothing to dial
  }
  if (!callRow) return false;

  await dialAndRecord(db, callRow.id, parent, caregiverName, medsForSlot, todaysAppointments);
  return true;
}
