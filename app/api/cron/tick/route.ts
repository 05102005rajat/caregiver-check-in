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

async function callParentNow(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  medsDue: Medication[],
  todaysAppointments: Appointment[],
  scheduledFor: Date
) {
  const { data: callRow, error: insertError } = await db
    .from("calls")
    .insert({
      parent_id: parent.id,
      scheduled_for: scheduledFor.toISOString(),
      status: "scheduled",
    })
    .select()
    .single();
  if (insertError || !callRow) {
    console.error("Failed to create calls row", insertError);
    return;
  }

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
      .eq("id", callRow.id);
  } catch (err) {
    console.error("Vapi call trigger failed", err);
    await db.from("calls").update({ status: "failed" }).eq("id", callRow.id);
  }
}

async function processRetries(db: ReturnType<typeof createAdminClient>, parent: Parent, rules: EscalationRules) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data: pastCalls } = await db
    .from("calls")
    .select("*")
    .eq("parent_id", parent.id)
    .gte("created_at", startOfDay.toISOString());

  const calls = (pastCalls ?? []) as Call[];
  const noAnswer = calls.filter((c) => c.status === "no_answer" && c.called_at);
  // Prior attempts today = rows we've already marked 'failed' as part of this retry chain,
  // since we flip a no_answer row to 'failed' the moment we spin up its retry (see below).
  const priorAttempts = calls.filter((c) => c.status === "failed").length;

  for (const call of noAnswer) {
    const minutesSinceCalled = minutesBetween(new Date(), new Date(call.called_at!));
    if (minutesSinceCalled < rules.retry_after_minutes) continue;

    await db.from("calls").update({ status: "failed" }).eq("id", call.id);

    if (priorAttempts >= rules.max_retries) {
      // Max retries reached. Miss-alert SMS to family_contacts (notify_on_miss) ships in Evening 3.
      continue;
    }

    const [meds, appts, caregiverName] = await Promise.all([
      db.from("medications").select("*").eq("parent_id", parent.id).eq("active", true),
      db.from("appointments").select("*").eq("parent_id", parent.id),
      getCaregiverName(db, parent.caregiver_id),
    ]);

    await callParentNow(
      db,
      parent,
      caregiverName,
      (meds.data ?? []) as Medication[],
      appointmentsToday((appts.data ?? []) as Appointment[], parent.timezone),
      new Date()
    );
  }
}

async function getCaregiverName(db: ReturnType<typeof createAdminClient>, caregiverId: string): Promise<string> {
  const { data } = await db.from("caregivers").select("name").eq("id", caregiverId).single();
  return data?.name ?? "your family";
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

  let callsTriggered = 0;

  for (const parent of (parents ?? []) as Parent[]) {
    const [medsRes, apptsRes, rulesRes] = await Promise.all([
      db.from("medications").select("*").eq("parent_id", parent.id).eq("active", true),
      db.from("appointments").select("*").eq("parent_id", parent.id),
      db.from("escalation_rules").select("*").eq("parent_id", parent.id).single(),
    ]);

    const medications = (medsRes.data ?? []) as Medication[];
    const appointments = (apptsRes.data ?? []) as Appointment[];
    const rules = rulesRes.data as EscalationRules | null;

    const due = medsDueNow(medications, parent.timezone, now);
    if (due.length > 0) {
      const caregiverName = await getCaregiverName(db, parent.caregiver_id);
      const slotTime = due[0].time_of_day;
      const scheduledFor = scheduledForToday(slotTime, parent.timezone, now);

      await callParentNow(
        db,
        parent,
        caregiverName,
        due,
        appointmentsToday(appointments, parent.timezone, now),
        scheduledFor
      );
      callsTriggered += 1;
    }

    if (rules) {
      await processRetries(db, parent, rules);
    }
  }

  return NextResponse.json({ ok: true, callsTriggered });
}
