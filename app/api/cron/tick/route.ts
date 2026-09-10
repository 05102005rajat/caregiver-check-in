import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerVapiCall } from "@/lib/vapi";
import { appointmentsToday, medsDueNow, minutesBetween, scheduledForToday } from "@/lib/schedule";
import type { Appointment, Call, EscalationRules, Medication, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

function formatMeds(meds: Medication[]): string {
  if (meds.length === 0) return "none";
  return meds.map((m) => (m.dose ? `${m.name} (${m.dose})` : m.name)).join(", ");
}

function formatAppointments(appts: Appointment[]): string {
  if (appts.length === 0) return "none";
  return appts.map((a) => a.title).join(", ");
}

async function getCaregiverName(db: ReturnType<typeof createAdminClient>, caregiverId: string): Promise<string> {
  const { data } = await db.from("caregivers").select("name").eq("id", caregiverId).single();
  return data?.name ?? "your family";
}

/** Fires the actual Vapi call and records the outcome on an already-created `calls` row. */
async function dialAndRecord(
  db: ReturnType<typeof createAdminClient>,
  callId: string,
  parent: Parent,
  caregiverName: string,
  medsDue: Medication[],
  todaysAppointments: Appointment[]
) {
  try {
    const vapiCall = await triggerVapiCall({
      toNumber: parent.phone,
      variableValues: {
        parent_name: parent.name,
        assistant_name: parent.preferred_voice,
        meds_due: formatMeds(medsDue),
        appointments_today: formatAppointments(todaysAppointments),
        family_setup_by: caregiverName,
      },
    });

    await db
      .from("calls")
      .update({ status: "in_progress", called_at: new Date().toISOString(), vapi_call_id: vapiCall.id })
      .eq("id", callId);
  } catch (err) {
    console.error("Vapi call trigger failed", err);
    await db.from("calls").update({ status: "failed" }).eq("id", callId);
  }
}

/** Creates the initial calls row for a due med slot and dials, skipping if already scheduled today. */
async function scheduleAndDial(
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
    .insert({ parent_id: parent.id, scheduled_for: scheduledFor.toISOString(), status: "scheduled" })
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

async function processRetries(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  rules: EscalationRules,
  medications: Medication[],
  appointments: Appointment[]
) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const { data: pastCalls } = await db
    .from("calls")
    .select("*")
    .eq("parent_id", parent.id)
    .eq("status", "no_answer")
    .gte("scheduled_for", oneDayAgo.toISOString());

  for (const call of (pastCalls ?? []) as Call[]) {
    if (!call.called_at) continue;
    const minutesSinceCalled = minutesBetween(new Date(), new Date(call.called_at));
    if (minutesSinceCalled < rules.retry_after_minutes) continue;

    const nextStatus = call.retry_count >= rules.max_retries ? "failed" : "in_progress";

    // Optimistic-concurrency claim: only proceeds if the row is still exactly as we
    // read it. If an overlapping cron tick already claimed it, this affects 0 rows and
    // we back off, instead of both invocations placing a duplicate retry call.
    const { data: claimed } = await db
      .from("calls")
      .update(
        nextStatus === "failed"
          ? { status: "failed" }
          : { status: "in_progress", retry_count: call.retry_count + 1 }
      )
      .eq("id", call.id)
      .eq("status", "no_answer")
      .eq("retry_count", call.retry_count)
      .select()
      .maybeSingle();

    if (!claimed || nextStatus === "failed") {
      // Either lost the race, or retries are exhausted for this slot: miss-alert SMS
      // to family_contacts (notify_on_miss) ships in Evening 3.
      continue;
    }

    await dialAndRecord(
      db,
      call.id,
      parent,
      caregiverName,
      medications,
      appointmentsToday(appointments, parent.timezone)
    );
  }
}

async function processParent(db: ReturnType<typeof createAdminClient>, parent: Parent, now: Date): Promise<number> {
  const [medsRes, apptsRes, rulesRes] = await Promise.all([
    db.from("medications").select("*").eq("parent_id", parent.id).eq("active", true),
    db.from("appointments").select("*").eq("parent_id", parent.id),
    db.from("escalation_rules").select("*").eq("parent_id", parent.id).single(),
  ]);

  const medications = (medsRes.data ?? []) as Medication[];
  const appointments = (apptsRes.data ?? []) as Appointment[];
  const rules = rulesRes.data as EscalationRules | null;

  const caregiverName = await getCaregiverName(db, parent.caregiver_id);
  const due = medsDueNow(medications, parent.timezone, now);
  const distinctSlotTimes = [...new Set(due.map((m) => m.time_of_day))];

  let callsTriggered = 0;
  for (const slotTime of distinctSlotTimes) {
    const medsForSlot = due.filter((m) => m.time_of_day === slotTime);
    const scheduledFor = scheduledForToday(slotTime, parent.timezone, now);

    const dialed = await scheduleAndDial(
      db,
      parent,
      caregiverName,
      medsForSlot,
      appointmentsToday(appointments, parent.timezone, now),
      scheduledFor
    );
    if (dialed) callsTriggered += 1;
  }

  if (rules) {
    await processRetries(db, parent, caregiverName, rules, medications, appointments);
  }

  return callsTriggered;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const now = new Date();

  const { data: parents, error: parentsError } = await db.from("parents").select("*");
  if (parentsError) {
    return NextResponse.json({ error: parentsError.message }, { status: 500 });
  }

  // Each parent's work is independent, so process them concurrently rather than
  // one at a time — keeps total tick duration flat as the caregiver count grows.
  const counts = await Promise.all(
    ((parents ?? []) as Parent[]).map((parent) => processParent(db, parent, now))
  );
  const callsTriggered = counts.reduce((sum, n) => sum + n, 0);

  return NextResponse.json({ ok: true, callsTriggered });
}
