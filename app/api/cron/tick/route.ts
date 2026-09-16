import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dialAndRecord, scheduleAndDial } from "@/lib/dial";
import { retryDecision } from "@/lib/retry";
import {
  appointmentRemindersDueNow,
  appointmentsToday,
  formatLocalTime,
  localDayBoundsUtc,
  medsAtLocalTime,
  medsDueNow,
  minutesBetween,
  scheduledForToday,
} from "@/lib/schedule";
import { formatAppointments, formatMeds } from "@/lib/format";
import { notifyFamilyContacts } from "@/lib/notify";
import type { Appointment, Call, EscalationRules, Medication, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

// How late medsDueNow's "due by now" catch-up is allowed to go before we give up calling
// and just tell the family it was missed. Recovers from a delayed cron tick without ever
// placing a very-late, confusing "check-in" call about a medication from hours ago.
const MAX_CATCHUP_MINUTES = 120;

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
  noAnswerCalls: Call[],
  now: Date
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
    const medsForSlot = call.scheduled_meds
      ? medications.filter((m) => call.scheduled_meds!.includes(m.name))
      : medsAtLocalTime(medications, scheduledFor, parent.timezone);

    if (nextStatus === "failed") {
      const time = formatLocalTime(scheduledFor, parent.timezone);
      // medsForSlot is empty for an appointment-only call (see appointmentRemindersDueNow
      // below) — falling back to formatMeds([]) there produced the nonsensical "Their
      // none was scheduled." Use the day's appointments instead when there's no
      // medication to report, so the alert actually names what was missed.
      const subject =
        medsForSlot.length > 0
          ? `Their ${formatMeds(medsForSlot)} was scheduled.`
          : (() => {
              const todaysAppts = appointmentsToday(appointments, parent.timezone, scheduledFor);
              return todaysAppts.length > 0 ? `Their ${formatAppointments(todaysAppts)} appointment was scheduled.` : "";
            })();
      const body = `Heads up: ${parent.name} didn't answer their ${time} check-in after ${rules.max_retries} tries. ${subject}`.trim();
      await notifyFamilyContacts(db, parent.id, "notify_on_miss", call.id, body);
      continue;
    }

    await dialAndRecord(
      db,
      call.id,
      parent,
      caregiverName,
      medsForSlot,
      appointmentsToday(appointments, parent.timezone, now)
    );
  }
}

/**
 * A calls row can get stuck in 'scheduled' forever if dialAndRecord's post-dial DB write
 * failed right after a successful Vapi call (rare, but the row never got its vapi_call_id
 * or a called_at, so the in_progress reaper below never sees it) — or, less likely, if
 * the process crashed between the insert and the dial. Re-attempts the dial on the same
 * row rather than leaving it stranded; the active-call unique index still protects against
 * this colliding with a genuinely in-flight call for the same parent.
 */
async function reapStaleScheduled(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  caregiverName: string,
  medications: Medication[],
  appointments: Appointment[],
  now: Date
) {
  // Same 10-minute (2x max call duration) buffer as the in_progress reaper below — a call
  // that's actually still ringing/talking can legitimately keep this row at 'scheduled'
  // for close to the full call duration if the post-dial bookkeeping write failed; a
  // shorter threshold risked re-dialing a parent mid-conversation.
  const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { data: staleRows } = await db
    .from("calls")
    .select("*")
    .eq("parent_id", parent.id)
    .eq("status", "scheduled")
    .lt("created_at", staleThreshold);

  for (const row of (staleRows ?? []) as Call[]) {
    const medsForSlot = row.scheduled_meds
      ? medications.filter((m) => row.scheduled_meds!.includes(m.name))
      : medsAtLocalTime(medications, new Date(row.scheduled_for), parent.timezone);
    await dialAndRecord(db, row.id, parent, caregiverName, medsForSlot, appointmentsToday(appointments, parent.timezone, now));
  }
}

/**
 * Whether a call already exists today (parent's local day) that either actually
 * connected (called_at set) or is still pending (scheduled/in_progress, so it will
 * connect or fail on its own). Used to decide whether an appointment reminder is still
 * needed — medsDueNow is cumulative for the whole day by design (delayed-tick catch-up),
 * so "was any medication slot ever due today" stays true even after that slot's call
 * fails outright, which would otherwise permanently block the appointment reminder for
 * the rest of the day even though nothing ever actually mentioned the appointment.
 */
async function hasCoveredCallToday(db: ReturnType<typeof createAdminClient>, parent: Parent, now: Date): Promise<boolean> {
  const { startUtc, endUtc } = localDayBoundsUtc(parent.timezone, now);
  const { data } = await db
    .from("calls")
    .select("called_at, status")
    .eq("parent_id", parent.id)
    .gte("scheduled_for", startUtc.toISOString())
    .lte("scheduled_for", endUtc.toISOString());
  return (data ?? []).some((c) => c.called_at || c.status === "scheduled" || c.status === "in_progress");
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

      if (minutesBetween(now, scheduledFor) > MAX_CATCHUP_MINUTES) {
        // Only one active (scheduled/in_progress) call per parent is ever allowed at a
        // time (calls_parent_active_unique). Checked fresh on every slot (not once
        // before the loop) since an earlier slot in this very loop may have just been
        // dialed. If one's active, this slot is merely queued behind it, not lost — skip
        // for this tick rather than wrongly reporting it to family as "too late."
        const { data: activeNow } = await db
          .from("calls")
          .select("id")
          .eq("parent_id", parent.id)
          .in("status", ["scheduled", "in_progress"])
          .limit(1)
          .maybeSingle();
        if (activeNow) continue;
        // Too late to place a sensible "check-in" call about this — tell the family it
        // was missed instead. The insert is still idempotency-guarded (parent_id,
        // scheduled_for) so a slow scheduler doesn't send this alert more than once.
        const { data: row, error } = await db
          .from("calls")
          .insert({
            parent_id: parent.id,
            scheduled_for: scheduledFor.toISOString(),
            status: "failed",
            scheduled_meds: medsForSlot.map((m) => m.name),
          })
          .select()
          .single();
        if (error) {
          if (error.code !== "23505") console.error("Failed to record skipped-too-late call", error);
          continue;
        }
        const time = formatLocalTime(scheduledFor, parent.timezone);
        const body = `Heads up: ${parent.name}'s ${time} check-in was missed and is now too late to call about. Their ${formatMeds(medsForSlot)} was scheduled.`;
        await notifyFamilyContacts(db, parent.id, "notify_on_miss", row.id, body);
        continue;
      }

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

    // Appointment-only fallback: the loop above only ever fires for a due medication, so
    // a parent with an appointment today but no medication due (including parents with
    // no medications configured at all) would otherwise never get called. Gated on
    // whether a call today already connected or is still pending — NOT on whether a
    // medication slot was merely due at some point today, since medsDueNow's due-by-now
    // semantics stay true for the rest of the day even after that slot's call fails
    // outright, which would otherwise permanently block the appointment reminder despite
    // nothing having actually mentioned the appointment. A normal day where the med call
    // does connect still places exactly one call, since that's already "covered".
    const dueApptReminders = appointmentRemindersDueNow(ctx.appointments, parent.timezone, now);
    if (dueApptReminders.length > 0 && !(await hasCoveredCallToday(db, parent, now))) {
      for (const { appointment, scheduledFor } of dueApptReminders) {
        if (minutesBetween(now, scheduledFor) > MAX_CATCHUP_MINUTES) {
          // Same catch-up-cutoff treatment as a missed medication (record it and tell
          // family) instead of silently dropping it — otherwise a badly-delayed
          // appointment reminder leaves no trace anywhere: no calls row, no dashboard
          // entry, no alert.
          const { data: activeNow } = await db
            .from("calls")
            .select("id")
            .eq("parent_id", parent.id)
            .in("status", ["scheduled", "in_progress"])
            .limit(1)
            .maybeSingle();
          if (activeNow) continue;
          const { data: row, error } = await db
            .from("calls")
            .insert({ parent_id: parent.id, scheduled_for: scheduledFor.toISOString(), status: "failed", scheduled_meds: [] })
            .select()
            .single();
          if (error) {
            if (error.code !== "23505") console.error("Failed to record skipped-too-late appointment call", error);
            continue;
          }
          const time = formatLocalTime(scheduledFor, parent.timezone);
          const body = `Heads up: ${parent.name}'s ${formatAppointments([appointment])} appointment reminder (around ${time}) was missed and is now too late to call about.`;
          await notifyFamilyContacts(db, parent.id, "notify_on_miss", row.id, body);
          continue;
        }
        const dialed = await scheduleAndDial(
          db,
          parent,
          ctx.caregiverName,
          [],
          appointmentsToday(ctx.appointments, parent.timezone, now),
          scheduledFor
        );
        if (dialed) callsTriggered += 1;
      }
    }

    await reapStaleScheduled(db, parent, ctx.caregiverName, ctx.medications, ctx.appointments, now);
  }

  if (ctx.rules) {
    await processRetries(db, parent, ctx.caregiverName, ctx.rules, ctx.medications, ctx.appointments, ctx.noAnswerCalls, now);
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
    const { error } = await db.from("cron_heartbeat").update({ last_tick_at: now.toISOString() }).eq("id", true);
    if (error) console.error("Failed to update cron heartbeat", error);
    return NextResponse.json({ ok: true, callsTriggered: 0 });
  }

  const parentIds = parentList.map((p) => p.id);
  const caregiverIds = [...new Set(parentList.map((p) => p.caregiver_id))];
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // A call stuck 'in_progress' means Vapi never sent an end-of-call-report for it (a
  // dropped webhook, a crashed call, etc.) — without this it would linger forever,
  // never retried and never escalated to family. Max call duration is 5 minutes, so 10
  // is a safe buffer before assuming it's not coming back. Routing it into 'no_answer'
  // puts it through the exact same retry/miss-alert pipeline as an actual no-answer.
  const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const { error: reapError } = await db
    .from("calls")
    .update({ status: "no_answer" })
    .in("parent_id", parentIds)
    .eq("status", "in_progress")
    .lt("called_at", staleThreshold);
  if (reapError) console.error("Failed to reap stale in_progress calls", reapError);

  // One batch of queries for all parents instead of per-parent round-trips, so tick
  // latency stays roughly constant as the number of caregivers grows.
  const [caregiversRes, medsRes, apptsRes, rulesRes, noAnswerRes, anyCallsRes] = await Promise.all([
    db.from("caregivers").select("id, name").in("id", caregiverIds),
    db.from("medications").select("*").in("parent_id", parentIds).eq("active", true),
    db.from("appointments").select("*").in("parent_id", parentIds),
    db.from("escalation_rules").select("*").in("parent_id", parentIds),
    db.from("calls").select("*").in("parent_id", parentIds).eq("status", "no_answer").gte("scheduled_for", oneDayAgo.toISOString()),
    // Only counts as a "prior call" for consent-gating if a real dial was actually
    // attempted. dialAndRecord explicitly sets status='failed' only when Vapi itself
    // rejected the call (never rang) — every other status (including 'scheduled', which
    // can mean "Vapi call succeeded but our own bookkeeping write failed right after")
    // means a real call did go out. Filtering on vapi_call_id instead would have let this
    // permanently read as "no prior calls" whenever that bookkeeping write fails, since
    // vapi_call_id is one of the fields that write sets — silently disabling the consent
    // gate and letting the system keep cold-calling the parent without consent.
    db.from("calls").select("parent_id").in("parent_id", parentIds).neq("status", "failed"),
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

  // /api/health reads this to tell whether the external scheduler is still running.
  const { error: heartbeatError } = await db
    .from("cron_heartbeat")
    .update({ last_tick_at: now.toISOString() })
    .eq("id", true);
  if (heartbeatError) console.error("Failed to update cron heartbeat", heartbeatError);

  return NextResponse.json({ ok: true, callsTriggered });
}
