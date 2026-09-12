import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dialAndRecord, scheduleAndDial } from "@/lib/dial";
import { retryDecision } from "@/lib/retry";
import { appointmentsToday, formatLocalTime, medsAtLocalTime, medsDueNow, scheduledForToday } from "@/lib/schedule";
import { formatMeds } from "@/lib/format";
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
    const decision = retryDecision(call, rules);
    if (decision === "wait") continue;

    const nextStatus = decision === "exhausted" ? "failed" : "in_progress";

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
  hasPriorCalls: boolean;
}

async function processParent(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  now: Date,
  ctx: ParentContext
): Promise<number> {
  // Consent gate (spec section 8): the very first call always goes out so Rosie can ask
  // for consent. Once at least one call has happened, further automatic scheduled calls
  // wait for consent_given_at to be set (the caregiver's manual test-call button, or a
  // future call, can still obtain it) rather than repeatedly cold-calling without consent.
  const consentBlocksNewCalls = ctx.hasPriorCalls && !parent.consent_given_at;

  const due = medsDueNow(ctx.medications, parent.timezone, now);
  const distinctSlotTimes = [...new Set(due.map((m) => m.time_of_day))];

  let callsTriggered = 0;
  if (!consentBlocksNewCalls) {
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
  const [caregiversRes, medsRes, apptsRes, rulesRes, noAnswerRes, anyCallsRes] = await Promise.all([
    db.from("caregivers").select("id, name").in("id", caregiverIds),
    db.from("medications").select("*").in("parent_id", parentIds).eq("active", true),
    db.from("appointments").select("*").in("parent_id", parentIds),
    db.from("escalation_rules").select("*").in("parent_id", parentIds),
    db.from("calls").select("*").in("parent_id", parentIds).eq("status", "no_answer").gte("scheduled_for", oneDayAgo.toISOString()),
    // Only counts as a "prior call" for consent-gating if it actually got far enough to
    // dial (has a vapi_call_id) — a row that only ever recorded a dial-time failure
    // (e.g. an infrastructure error) shouldn't permanently block every future attempt
    // to reach consent, since the parent never got a chance to hear the question.
    db.from("calls").select("parent_id").in("parent_id", parentIds).not("vapi_call_id", "is", null),
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
  const parentIdsWithPriorCalls = new Set((anyCallsRes.data ?? []).map((r) => r.parent_id as string));

  const counts = await Promise.all(
    parentList.map((parent) =>
      processParent(db, parent, now, {
        caregiverName: caregiverNameById.get(parent.caregiver_id) ?? "your family",
        medications: medsByParent.get(parent.id) ?? [],
        appointments: apptsByParent.get(parent.id) ?? [],
        rules: rulesByParent.get(parent.id) ?? null,
        noAnswerCalls: noAnswerByParent.get(parent.id) ?? [],
        hasPriorCalls: parentIdsWithPriorCalls.has(parent.id),
      })
    )
  );
  const callsTriggered = counts.reduce((sum, n) => sum + n, 0);

  return NextResponse.json({ ok: true, callsTriggered });
}
