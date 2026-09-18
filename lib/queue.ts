import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleAndDial } from "@/lib/dial";
import { appointmentsToday, formatLocalTime, localDayBoundsUtc } from "@/lib/schedule";
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

/**
 * How long a slot may sit claimed-but-undialled before another tick takes it back. Matches
 * the 10-minute buffer the `calls` reapers use — two maximum call durations.
 */
const STRANDED_DISPATCH_MINUTES = 10;

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

  // Reconcile what is already queued for today against what the plan now says. Inserting
  // and never revisiting was wrong in two ways, both of them silent:
  //
  //   - a cancelled slot could never come back. cancelPendingSlots drops the whole
  //     remaining day when a parent is paused, and `ignoreDuplicates` meant the tick after
  //     Resume re-planned that slot and changed nothing. The evening check-in was never
  //     dialled, never expired and never alerted — the exact failure this queue exists to
  //     make impossible.
  //   - a slot outlived the medication it was for. The old scheduler re-derived from the
  //     current rows every tick, so editing a dose from 18:00 to 19:00 simply moved the
  //     call; here it left the 18:00 slot standing and added a 19:00 one, ringing twice.
  const { startUtc, endUtc } = localDayBoundsUtc(parent.timezone, now);
  const plannedByDue = new Map(slots.map((slot) => [slot.dueAt.getTime(), slot]));

  const { data: existing, error: existingError } = await db
    .from("call_slots")
    .select("id, due_at, med_names, state")
    .eq("parent_id", parent.id)
    .gte("due_at", startUtc.toISOString())
    .lte("due_at", endUtc.toISOString());
  if (existingError) {
    log.error("cron.existing_slots_query_failed", { parent_id: parent.id, err: existingError });
    return;
  }

  const rows = (existing ?? []) as Array<Pick<CallSlot, "id" | "due_at" | "med_names" | "state">>;
  const sameMeds = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  // Still pending but no longer planned at all: the medication moved or was removed.
  // Only pending rows — a dispatched or expired slot is history, not a plan.
  const orphaned = rows.filter((r) => r.state === "pending" && !plannedByDue.has(new Date(r.due_at).getTime()));
  if (orphaned.length > 0) {
    const { error } = await db.from("call_slots").delete().in("id", orphaned.map((r) => r.id)).eq("state", "pending");
    if (error) log.error("cron.orphan_slots_delete_failed", { parent_id: parent.id, err: error });
    else log.info("cron.orphan_slots_deleted", { parent_id: parent.id, count: orphaned.length });
  }

  // Planned again after being cancelled: the hold that cancelled it is over.
  // planSlotsForDay only plans slots at or after coverageStartsAt, so a slot that elapsed
  // during the pause is not planned and therefore never revived.
  const revivable = rows.filter((r) => r.state === "cancelled" && plannedByDue.has(new Date(r.due_at).getTime()));
  if (revivable.length > 0) {
    const { error } = await db
      .from("call_slots")
      .update({ state: "pending", updated_at: now.toISOString() })
      .in("id", revivable.map((r) => r.id))
      .eq("state", "cancelled");
    if (error) log.error("cron.revive_slots_failed", { parent_id: parent.id, err: error });
    else log.info("cron.slots_revived", { parent_id: parent.id, count: revivable.length });
  }

  // Same time, different medications.
  for (const row of rows) {
    if (row.state !== "pending") continue;
    const planned = plannedByDue.get(new Date(row.due_at).getTime());
    if (!planned || sameMeds(row.med_names, planned.medNames)) continue;
    const { error } = await db
      .from("call_slots")
      .update({ med_names: planned.medNames, updated_at: now.toISOString() })
      .eq("id", row.id)
      .eq("state", "pending");
    if (error) log.error("cron.slot_meds_update_failed", { parent_id: parent.id, slot_id: row.id, err: error });
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
  // A claim writes 'dispatched' before the dial. If the invocation dies in between — a
  // Vercel timeout, a crash — the slot matches neither the dispatch query (pending) nor the
  // expiry query (pending) and sits there forever: no call, no alert, no trace. `calls` rows
  // have had a reaper for exactly this since 0027; slots need the same. Released rather than
  // failed, because expires_at still bounds it and expiry is the one place that declares a
  // miss. call_id is the discriminator: a slot that really dialled has one.
  const strandedBefore = new Date(now.getTime() - STRANDED_DISPATCH_MINUTES * 60000).toISOString();
  const { data: stranded, error: strandedError } = await db
    .from("call_slots")
    .update({ state: "pending", updated_at: now.toISOString() })
    .eq("parent_id", parent.id)
    .eq("state", "dispatched")
    .is("call_id", null)
    .lt("updated_at", strandedBefore)
    .select("id");
  if (strandedError) log.error("cron.stranded_slots_release_failed", { parent_id: parent.id, err: strandedError });
  else if ((stranded ?? []).length > 0) {
    log.warn("cron.stranded_slots_released", { parent_id: parent.id, count: stranded!.length });
  }

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
    // Did we actually ring for this slot? A slot is released back to pending whenever a
    // dial doesn't produce a call, including a provider error — and a provider error routes
    // the `calls` row into the retry pipeline, where a retry can connect. The slot is still
    // pending when its deadline passes, so expiring it blindly reuses the now-completed call
    // row and texts the family "check-in was missed" about a check-in that happened.
    //
    // dial_attempted_at is the right question to ask, and it is stamped before the dial
    // precisely so it survives whatever happens afterwards (0027). If it is set, we rang,
    // and the webhook and retry pipeline own reporting the outcome — not this branch.
    const { data: existingCall } = await db
      .from("calls")
      .select("id, status, dial_attempted_at")
      .eq("parent_id", parent.id)
      .eq("scheduled_for", slot.due_at)
      .maybeSingle();

    if (existingCall?.dial_attempted_at) {
      const { data: served } = await db
        .from("call_slots")
        .update({ state: "dispatched", call_id: existingCall.id, updated_at: now.toISOString() })
        .eq("id", slot.id)
        .eq("state", "pending")
        .select("id")
        .maybeSingle();
      if (served) {
        log.info("cron.slot_rang_after_all", {
          parent_id: parent.id,
          slot_id: slot.id,
          call_id: existingCall.id,
          call_status: existingCall.status,
        });
      }
      continue;
    }

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
    let callId: string | null = existingCall?.id ?? null;
    if (!callId) {
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
        // 23505 means a row appeared between the read above and this insert. Re-read rather
        // than abandoning the alert, which is what a bare `continue` used to do.
        if (insertError.code !== "23505") {
          log.error("cron.expired_slot_call_insert_failed", { parent_id: parent.id, slot_id: slot.id, err: insertError });
          continue;
        }
        const { data: raced } = await db
          .from("calls")
          .select("id")
          .eq("parent_id", parent.id)
          .eq("scheduled_for", slot.due_at)
          .maybeSingle();
        callId = raced?.id ?? null;
      } else {
        callId = inserted?.id ?? null;
      }
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
