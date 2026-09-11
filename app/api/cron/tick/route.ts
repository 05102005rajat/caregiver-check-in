import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerVapiCall } from "@/lib/vapi";
import {
  appointmentsToday,
  formatLocalTime,
  medsAtLocalTime,
  medsDueNow,
  minutesBetween,
  scheduledForToday,
} from "@/lib/schedule";
import { formatAppointments, formatMeds } from "@/lib/format";
import { notifyFamilyContacts } from "@/lib/notify";
import type { Appointment, Call, EscalationRules, Medication, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

function groupByParentId<T extends { parent_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.parent_id);
    if (bucket) bucket.push(row);
    else map.set(row.parent_id, [row]);
  }
  return map;
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
  let vapiCall;
  try {
    vapiCall = await triggerVapiCall({
      toNumber: parent.phone,
      variableValues: {
        parent_name: parent.name,
        assistant_name: parent.preferred_voice,
        meds_due: formatMeds(medsDue),
        appointments_today: formatAppointments(todaysAppointments),
        family_setup_by: caregiverName,
      },
    });
  } catch (err) {
    console.error("Vapi call trigger failed", err);
    await db.from("calls").update({ status: "failed" }).eq("id", callId);
    return;
  }

  const { error } = await db
    .from("calls")
    .update({ status: "in_progress", called_at: new Date().toISOString(), vapi_call_id: vapiCall.id })
    .eq("id", callId);
  if (error) {
    // The call was actually placed — don't mark this 'failed', that would misreport a
    // successful dial and orphan the row from the webhook's vapi_call_id lookup for no reason
    // beyond our own bookkeeping hiccup. Leave status as-is and just log for investigation.
    console.error(`Failed to record vapi_call_id ${vapiCall.id} for calls row ${callId}`, error);
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
  appointments: Appointment[],
  noAnswerCalls: Call[]
) {
  for (const call of noAnswerCalls) {
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

    if (!claimed) continue; // lost the race to another cron invocation

    const scheduledFor = new Date(call.scheduled_for);
    const medsForSlot = medsAtLocalTime(medications, scheduledFor, parent.timezone);

    if (nextStatus === "failed") {
      const time = formatLocalTime(scheduledFor, parent.timezone);
      const body = `Heads up: ${parent.name} didn't answer their ${time} check-in after ${rules.max_retries} tries. Their ${formatMeds(medsForSlot)} was scheduled.`;
      await notifyFamilyContacts(db, parent.id, "notify_on_miss", call.id, body);
      continue;
    }

    await dialAndRecord(
      db,
      call.id,
      parent,
      caregiverName,
      medsForSlot,
      appointmentsToday(appointments, parent.timezone)
    );
  }
}

interface ParentContext {
  caregiverName: string;
  medications: Medication[];
  appointments: Appointment[];
  rules: EscalationRules | null;
  noAnswerCalls: Call[];
}

async function processParent(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  now: Date,
  ctx: ParentContext
): Promise<number> {
  const due = medsDueNow(ctx.medications, parent.timezone, now);
  const distinctSlotTimes = [...new Set(due.map((m) => m.time_of_day))];

  let callsTriggered = 0;
  for (const slotTime of distinctSlotTimes) {
    const medsForSlot = due.filter((m) => m.time_of_day === slotTime);
    const scheduledFor = scheduledForToday(slotTime, parent.timezone, now);

    const dialed = await scheduleAndDial(
      db,
      parent,
      ctx.caregiverName,
      medsForSlot,
      appointmentsToday(ctx.appointments, parent.timezone, now),
      scheduledFor
    );
    if (dialed) callsTriggered += 1;
  }

  if (ctx.rules) {
    await processRetries(db, parent, ctx.caregiverName, ctx.rules, ctx.medications, ctx.appointments, ctx.noAnswerCalls);
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

  const parentList = (parents ?? []) as Parent[];
  if (parentList.length === 0) {
    return NextResponse.json({ ok: true, callsTriggered: 0 });
  }

  const parentIds = parentList.map((p) => p.id);
  const caregiverIds = [...new Set(parentList.map((p) => p.caregiver_id))];
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // One batch of queries for all parents instead of per-parent round-trips, so tick
  // latency stays roughly constant as the number of caregivers grows.
  const [caregiversRes, medsRes, apptsRes, rulesRes, noAnswerRes] = await Promise.all([
    db.from("caregivers").select("id, name").in("id", caregiverIds),
    db.from("medications").select("*").in("parent_id", parentIds).eq("active", true),
    db.from("appointments").select("*").in("parent_id", parentIds),
    db.from("escalation_rules").select("*").in("parent_id", parentIds),
    db.from("calls").select("*").in("parent_id", parentIds).eq("status", "no_answer").gte("scheduled_for", oneDayAgo.toISOString()),
  ]);

  const caregiverNameById = new Map<string, string>(
    (caregiversRes.data ?? []).map((c) => [c.id as string, c.name as string])
  );
  const medsByParent = groupByParentId((medsRes.data ?? []) as Medication[]);
  const apptsByParent = groupByParentId((apptsRes.data ?? []) as Appointment[]);
  const rulesByParent = new Map<string, EscalationRules>(
    ((rulesRes.data ?? []) as EscalationRules[]).map((r) => [r.parent_id, r])
  );
  const noAnswerByParent = groupByParentId((noAnswerRes.data ?? []) as Call[]);

  const counts = await Promise.all(
    parentList.map((parent) =>
      processParent(db, parent, now, {
        caregiverName: caregiverNameById.get(parent.caregiver_id) ?? "your family",
        medications: medsByParent.get(parent.id) ?? [],
        appointments: apptsByParent.get(parent.id) ?? [],
        rules: rulesByParent.get(parent.id) ?? null,
        noAnswerCalls: noAnswerByParent.get(parent.id) ?? [],
      })
    )
  );
  const callsTriggered = counts.reduce((sum, n) => sum + n, 0);

  return NextResponse.json({ ok: true, callsTriggered });
}
