import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleAndDial } from "@/lib/dial";
import { appointmentsToday, formatLocalTime } from "@/lib/schedule";
import { coverageStartsAt, planSlotsForDay } from "@/lib/slots";
import { formatMeds } from "@/lib/format";
import { notifyFamilyContacts } from "@/lib/notify";
import { tooLateFingerprint } from "@/lib/insights";
import { log } from "@/lib/log";
import type { Appointment, CallSlot, Medication, Parent, WatchItem } from "@/types/db";

/**
 * The day's queue, as operations against it.
 *
 * Split from lib/slots.ts on purpose: that module decides what the day should look like and
 * is pure, this one talks to the database. Both are out of the route file so a harness can
 * drive them with a controlled `now` — the old scheduler could only be exercised by running
 * a real cron tick, which on this product means placing real phone calls to a real elderly
 * person, so in practice it was never exercised at all.
 */

/** What a queue operation needs to know about the household, beyond the parent row. */
export interface QueueContext {
  caregiverName: string;
  medications: Medication[];
  appointments: Appointment[];
  watchItems: WatchItem[];
}

/**
 * Writes down what today should look like for this parent. Idempotent: the unique
 * (parent_id, due_at) index decides what is actually new, so running it every tick is a
 * no-op after the first one of the day.
 */
export async function materializeSlots(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  ctx: QueueContext,
  now: Date
) {
  const { slots, uncallable } = planSlotsForDay(ctx.medications, ctx.appointments, parent.timezone, now, coverageStartsAt(parent));

  for (const skipped of uncallable) {
    // A medication time that predates the calling-hours check in lib/validation.ts. It can
    // never be rung, and queueing it would expire unrung every night and text the family
    // daily. Logged loudly rather than dropped in silence — this is still open debt (a
    // backfill or a dashboard warning), and the log line is the only thing standing in for
    // it today.
    log.warn("cron.slot_uncallable", {
      parent_id: parent.id,
      reason: skipped.reason,
      time_of_day: skipped.timeOfDay,
      meds: skipped.medNames,
    });
  }

  if (slots.length === 0) return;

  const { error } = await db.from("call_slots").upsert(
    slots.map((slot) => ({
      parent_id: parent.id,
      due_at: slot.dueAt.toISOString(),
      expires_at: slot.expiresAt.toISOString(),
      kind: slot.kind,
      med_names: slot.medNames,
      appointment_id: slot.appointmentId,
    })),
    { onConflict: "parent_id,due_at", ignoreDuplicates: true }
  );
  if (error) log.error("cron.materialize_slots_failed", { parent_id: parent.id, err: error });
}

/** Rings everything that is due and hasn't lapsed. Returns how many calls were placed. */
export async function dispatchDueSlots(
  db: ReturnType<typeof createAdminClient>,
  parent: Parent,
  ctx: QueueContext,
  now: Date
): Promise<number> {
  const { data: dueSlots, error } = await db
    .from("call_slots")
    .select("*")
    .eq("parent_id", parent.id)
    .eq("state", "pending")
    .lte("due_at", now.toISOString())
    .gt("expires_at", now.toISOString())
    .order("due_at", { ascending: true });
  if (error) {
    log.error("cron.due_slots_query_failed", { parent_id: parent.id, err: error });
    return 0;
  }

  let triggered = 0;
  for (const slot of (dueSlots ?? []) as CallSlot[]) {
    // Claim before dialing, and read back whether the claim landed. A guarded UPDATE that
    // matches zero rows is indistinguishable from one that matched, which is how an
    // overlapping tick ends up placing a second call to the same person.
    const { data: claimed } = await db
      .from("call_slots")
      .update({ state: "dispatched", updated_at: now.toISOString() })
      .eq("id", slot.id)
      .eq("state", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const medsForSlot = ctx.medications.filter((m) => slot.med_names.includes(m.name));
    const outcome = await scheduleAndDial(
      db,
      parent,
      ctx.caregiverName,
      medsForSlot,
      appointmentsToday(ctx.appointments, parent.timezone, now),
      new Date(slot.due_at),
      ctx.watchItems
    );

    if (outcome.dialed) {
      triggered += 1;
      const { error: linkError } = await db
        .from("call_slots")
        .update({ call_id: outcome.callId, updated_at: new Date().toISOString() })
        .eq("id", slot.id);
      if (linkError) log.error("cron.slot_link_failed", { parent_id: parent.id, slot_id: slot.id, err: linkError });
      continue;
    }

    // Released back to pending, whatever went wrong. The slot is queued behind an active
    // call, or the database refused the insert, or the provider is down — none of which
    // means the check-in is over. It stays eligible until expires_at, and expiry is then
    // the single place that decides a slot was missed. Marking it dispatched-and-forgotten
    // here would reintroduce exactly the defect this redesign is for: a call that never
    // happened, with nothing recording that it didn't.
    const { error: releaseError } = await db
      .from("call_slots")
      .update({ state: "pending", updated_at: new Date().toISOString() })
      .eq("id", slot.id)
      .eq("state", "dispatched");
    if (releaseError) log.error("cron.slot_release_failed", { parent_id: parent.id, slot_id: slot.id, err: releaseError });
    log.info("cron.slot_released", { parent_id: parent.id, slot_id: slot.id, reason: outcome.reason });
  }
  return triggered;
}

/**
 * Accounts for slots that lapsed without a call. One branch, where there used to be two
 * near-identical ones with their own inserts and their own fingerprints.
 */
export async function expireLapsedSlots(db: ReturnType<typeof createAdminClient>, parent: Parent, now: Date) {
  const { data: lapsed, error } = await db
    .from("call_slots")
    .select("*")
    .eq("parent_id", parent.id)
    .eq("state", "pending")
    .lte("expires_at", now.toISOString());
  if (error) {
    log.error("cron.expired_slots_query_failed", { parent_id: parent.id, err: error });
    return;
  }

  for (const slot of (lapsed ?? []) as CallSlot[]) {
    const { data: claimed } = await db
      .from("call_slots")
      .update({ state: "expired", updated_at: now.toISOString() })
      .eq("id", slot.id)
      .eq("state", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // another tick already accounted for this one

    // A `calls` row so the miss is visible where the caregiver actually looks. Same
    // placeholder the old too-late branches wrote, and the unique (parent_id, scheduled_for)
    // index still makes it idempotent.
    let callId: string | null = null;
    const { data: inserted, error: insertError } = await db
      .from("calls")
      .insert({
        parent_id: parent.id,
        scheduled_for: slot.due_at,
        status: "failed",
        scheduled_meds: slot.med_names,
      })
      .select("id")
      .single();
    if (insertError) {
      if (insertError.code !== "23505") {
        log.error("cron.expired_slot_call_insert_failed", { parent_id: parent.id, slot_id: slot.id, err: insertError });
        continue;
      }
      // A row for this slot already exists — it was dialled and failed, or a refusal closed
      // it out. Reuse it rather than abandoning the alert, which is what a bare `continue`
      // on 23505 used to do.
      const { data: existing } = await db
        .from("calls")
        .select("id")
        .eq("parent_id", parent.id)
        .eq("scheduled_for", slot.due_at)
        .maybeSingle();
      callId = existing?.id ?? null;
    } else {
      callId = inserted?.id ?? null;
    }
    if (!callId) {
      log.error("cron.expired_slot_no_call_row", { parent_id: parent.id, slot_id: slot.id });
      continue;
    }

    await db.from("call_slots").update({ call_id: callId, updated_at: new Date().toISOString() }).eq("id", slot.id);

    const time = formatLocalTime(new Date(slot.due_at), parent.timezone);
    const body =
      slot.kind === "appointment"
        ? `Heads up: ${parent.name}'s appointment reminder call (around ${time}) didn't go out and it's now too late to place it. Please check in with them directly.`
        : `Heads up: ${parent.name}'s ${time} check-in was missed and is now too late to call about.${
            slot.med_names.length > 0 ? ` Their ${formatMeds(slot.med_names.map((name) => ({ name }) as Medication))} was scheduled.` : ""
          }`;
    await notifyFamilyContacts(db, parent.id, "notify_on_miss", callId, body, {
      // Shared with lib/dial.ts's refusal path and the stale reaper, so one missed slot
      // produces one text however many paths notice it.
      fingerprint: tooLateFingerprint(slot.due_at),
      severity: "safety",
    });
    log.info("cron.slot_expired", { parent_id: parent.id, slot_id: slot.id, due_at: slot.due_at, kind: slot.kind });
  }
}

/**
 * Drops the rest of the queue. Used when we stop being responsible mid-day — a pause, a
 * pre-warm hold, or a consent gate closing. Without it those slots sit pending until they
 * lapse and then report themselves as missed check-ins, which is the opposite of what a
 * pause means.
 */
export async function cancelPendingSlots(
  db: ReturnType<typeof createAdminClient>,
  parentId: string,
  reason: string,
  now: Date
) {
  const { data, error } = await db
    .from("call_slots")
    .update({ state: "cancelled", updated_at: now.toISOString() })
    .eq("parent_id", parentId)
    .eq("state", "pending")
    .select("id");
  if (error) {
    log.error("cron.cancel_slots_failed", { parent_id: parentId, reason, err: error });
    return;
  }
  if ((data ?? []).length > 0) {
    log.info("cron.slots_cancelled", { parent_id: parentId, reason, count: data!.length });
  }
}
