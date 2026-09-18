/**
 * Runtime harness for the call queue (migration 0033).
 *
 *   npm run security:queue
 *
 * Run deliberately: it creates a real (throwaway) household against the configured Supabase
 * project, drives lib/queue.ts against it, and cleans up in a finally.
 *
 * The scheduler this replaces could only be exercised by running a real cron tick, which on
 * this product means placing real phone calls to a real elderly person — so in practice it
 * was never exercised, and it regressed in four of five review rounds. The queue's
 * operations take `now` as an argument precisely so this file can drive a whole day in a
 * few seconds without touching the clock or the live households.
 *
 * Numbers are non-routable +1202555 (HANDOVER): Twilio accepts and never delivers, so the
 * notify path runs for real without reaching a handset.
 */
import { createClient } from "@supabase/supabase-js";
import { cancelPendingSlots, dispatchDueSlots, expireLapsedSlots, materializeSlots } from "@/lib/queue";
import { SLOT_CATCHUP_MINUTES } from "@/lib/slots";
import { isWithinCallingHours } from "@/lib/callwindow";
import { tooLateFingerprint } from "@/lib/insights";
import type { CallSlot, Medication, Parent } from "@/types/db";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !SERVICE) {
  console.error("Missing Supabase env vars — source .env.local first.");
  process.exit(1);
}
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const n = () => `+1202555${Math.floor(1000 + Math.random() * 9000)}`;
const CG_PHONE = n(), PARENT_PHONE = n(), CONTACT_PHONE = n();
const ZONES = ["Pacific/Auckland", "Asia/Tokyo", "Asia/Kolkata", "Europe/London", "America/Sao_Paulo", "America/Los_Angeles"];

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n    ${detail}`}`);
  ok ? pass++ : fail++;
}

const hhmm = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

async function slotsOf(parentId: string): Promise<CallSlot[]> {
  const { data } = await admin.from("call_slots").select("*").eq("parent_id", parentId).order("due_at");
  return (data ?? []) as CallSlot[];
}

async function main() {
  const realNow = new Date();
  // A zone where it is currently late morning locally, so both an elapsed slot and a future
  // slot fit inside today's calling window and a dial is actually permitted.
  const tz = ZONES.find((z) => {
    const h = Number(hhmm(realNow, z).slice(0, 2));
    return h >= 10 && h <= 16;
  });
  if (!tz) throw new Error("no zone currently mid-morning — rerun later");
  const localHour = Number(hhmm(realNow, tz).slice(0, 2));
  // 45 minutes ago, not two hours: a slot seeded exactly SLOT_CATCHUP_MINUTES in the past
  // has already reached its own expiry, so the "expiry leaves unexpired slots alone"
  // control below would be asserting against a slot that had legitimately expired — the
  // control would fail for a reason that has nothing to do with the code under test.
  const elapsedTime = hhmm(new Date(realNow.getTime() - 45 * 60000), tz);
  const futureTime = hhmm(new Date(realNow.getTime() + 90 * 60000), tz);
  console.log(`timezone=${tz} local=${hhmm(realNow, tz)} elapsed_slot=${elapsedTime} future_slot=${futureTime}\n`);

  const email = `queue-probe-${Date.now()}@example.invalid`;
  const { data: u, error: uErr } = await admin.auth.admin.createUser({ email, password: `pw-${Date.now()}`, email_confirm: true });
  if (uErr || !u.user) throw new Error(`createUser: ${uErr?.message}`);
  const cg = u.user.id;
  let pid = "";

  try {
    const { data: p, error } = await admin.rpc("save_parent_setup", {
      p_caregiver_id: cg, p_caregiver_email: email, p_caregiver_name: "Queue Probe",
      p_caregiver_phone: CG_PHONE, p_parent_name: "Queue Parent", p_parent_phone: PARENT_PHONE,
      p_parent_timezone: tz, p_assistant_name: "Rosie",
      p_medications: [
        { name: "EarlyMed", dose: "", time_of_day: elapsedTime, notes: "", description: "", start_date: "", end_date: "" },
        { name: "LaterMed", dose: "", time_of_day: futureTime, notes: "", description: "", start_date: "", end_date: "" },
      ],
      p_appointments: [],
      p_family_contacts: [{ name: "Queue Contact", phone: CONTACT_PHONE, email: "", role: "son", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true }],
      p_watch_items: [], p_retry_after_minutes: 30, p_max_retries: 2,
    });
    if (error || !p) throw new Error(`setup: ${error?.message}`);
    pid = p as string;

    // Backdate creation to just after local midnight, so coverage includes the elapsed
    // slot. Otherwise coverageStartsAt is "now" and that slot was never ours to miss —
    // correct behaviour, but it is not the case under test here.
    const midnightish = new Date(realNow.getTime() - (localHour + 0.5) * 3600 * 1000);
    await admin.from("parents").update({ created_at: midnightish.toISOString() }).eq("id", pid);
    // Consent, so the gate doesn't shut before any of this runs — backdated with creation.
    // consent_given_at feeds coverageStartsAt (a slot from before this parent agreed to be
    // called was never ours to miss), so stamping it "now" would correctly exclude every
    // elapsed slot and quietly empty the fixture these checks depend on.
    await admin.from("parents").update({ consent_given_at: midnightish.toISOString() }).eq("id", pid);

    const { data: parentRow } = await admin.from("parents").select("*").eq("id", pid).single();
    const parent = parentRow as Parent;
    const { data: medRows } = await admin.from("medications").select("*").eq("parent_id", pid);
    const ctx = { caregiverName: "Queue Probe", medications: (medRows ?? []) as Medication[], appointments: [], watchItems: [], sourcesComplete: true };

    // ---- materialise ----
    await materializeSlots(admin as never, parent, ctx, realNow);
    let slots = await slotsOf(pid);
    check("materialises one slot per medication time", slots.length === 2, `${slots.length} slots: ${JSON.stringify(slots.map((s) => s.due_at))}`);
    check("every slot starts pending", slots.every((s) => s.state === "pending"), JSON.stringify(slots.map((s) => s.state)));
    check(
      "a slot that elapsed while we were responsible IS queued (the outage case)",
      slots.some((s) => new Date(s.due_at) < realNow),
      "no elapsed slot — a missed check-in would go unreported"
    );
    const elapsed = slots.find((s) => new Date(s.due_at) < realNow)!;
    const future = slots.find((s) => new Date(s.due_at) > realNow)!;
    check(
      "expiry is the catch-up window, bounded by the calling window",
      new Date(elapsed.expires_at).getTime() - new Date(elapsed.due_at).getTime() <= SLOT_CATCHUP_MINUTES * 60000,
      `${(new Date(elapsed.expires_at).getTime() - new Date(elapsed.due_at).getTime()) / 60000} min`
    );
    check("queued slots are all inside calling hours", slots.every((s) => isWithinCallingHours(new Date(s.due_at), tz)));

    // ---- idempotent ----
    await materializeSlots(admin as never, parent, ctx, realNow);
    slots = await slotsOf(pid);
    check("re-materialising the same day adds nothing", slots.length === 2, `${slots.length} slots after second pass`);

    // ---- dispatch: CONTROL, nothing that isn't due ----
    // A blocking active call means scheduleAndDial returns already_scheduled, so nothing is
    // dialled here and the release path is what gets exercised.
    const { data: blocker } = await admin
      .from("calls")
      .insert({ parent_id: pid, scheduled_for: new Date(realNow.getTime() - 60 * 60 * 1000).toISOString(), status: "scheduled" })
      .select("id")
      .single();
    const { triggered } = await dispatchDueSlots(admin as never, parent, ctx, realNow);
    slots = await slotsOf(pid);
    const elapsedAfter = slots.find((s) => s.id === elapsed.id)!;
    const futureAfter = slots.find((s) => s.id === future.id)!;
    check("a blocked dispatch places no call", triggered === 0, `${triggered} calls`);
    check(
      "a slot blocked by an in-flight call is RELEASED, not consumed",
      elapsedAfter.state === "pending",
      `state=${elapsedAfter.state} — a consumed slot is a check-in that silently never happens`
    );
    check("dispatch leaves a slot that isn't due yet alone (control)", futureAfter.state === "pending" && futureAfter.call_id === null);

    await admin.from("calls").delete().eq("id", blocker!.id);

    // ---- expire ----
    // Control first: nothing has expired yet, so this must be a no-op.
    await expireLapsedSlots(admin as never, parent, realNow);
    slots = await slotsOf(pid);
    check("expiry leaves unexpired slots alone (control)", slots.every((s) => s.state === "pending"), JSON.stringify(slots.map((s) => s.state)));

    // Push the elapsed slot past its deadline and account for it.
    await admin.from("call_slots").update({ expires_at: new Date(realNow.getTime() - 60000).toISOString() }).eq("id", elapsed.id);
    await expireLapsedSlots(admin as never, parent, realNow);
    slots = await slotsOf(pid);
    const expiredSlot = slots.find((s) => s.id === elapsed.id)!;
    const fp = tooLateFingerprint(elapsed.due_at);
    const { data: msgs } = await admin.from("messages").select("recipient,body").eq("parent_id", pid).eq("fingerprint", fp);
    check("a lapsed slot is marked expired", expiredSlot.state === "expired", `state=${expiredSlot.state}`);
    check("a lapsed slot gets a calls row so the miss is visible", expiredSlot.call_id !== null);
    check("a lapsed slot TELLS THE FAMILY", (msgs ?? []).length > 0, `${(msgs ?? []).length} messages`);
    if (msgs?.[0]) console.log(`    body: ${msgs[0].body}`);
    check(
      "the miss names the medication that was scheduled",
      Boolean(msgs?.[0]?.body?.includes("EarlyMed")),
      msgs?.[0]?.body ?? "(no message)"
    );

    // ---- expiring twice must not text twice ----
    const before = (msgs ?? []).length;
    await expireLapsedSlots(admin as never, parent, realNow);
    const { data: msgsAgain } = await admin.from("messages").select("id").eq("parent_id", pid).eq("fingerprint", fp);
    check("a second expiry pass does not re-alert", (msgsAgain ?? []).length === before, `${before} -> ${(msgsAgain ?? []).length}`);

    // ---- a failed source read must never delete the day ----
    // Materialisation reconciles, so a plan built from an empty medications list deletes
    // every pending slot for today. A failed query defaults to [] and is indistinguishable
    // from "no medications" — so without this guard a transient database error destroys
    // slots that then never expire, never produce a calls row and never text anyone.
    const beforeWipe = (await slotsOf(pid)).filter((s) => s.state === "pending").length;
    await materializeSlots(admin as never, parent, { ...ctx, medications: [], sourcesComplete: false }, realNow);
    const afterWipe = (await slotsOf(pid)).filter((s) => s.state === "pending").length;
    check(
      "an incomplete source read leaves the queue alone",
      afterWipe === beforeWipe && beforeWipe > 0,
      `${beforeWipe} pending before, ${afterWipe} after — a transient query error deleted the day`
    );

    // A lapsed-but-unexpired slot must survive reconciliation. materializeSlots runs before
    // expireLapsedSlots, so deleting it as an orphan consumes a genuine missed check-in: the
    // dial failed and released it to pending, the caregiver then moved that medication, and
    // the next tick deleted the slot before expiry could write a calls row or tell anyone.
    const lapsedDue = new Date(realNow.getTime() - 3 * 60 * 60000).toISOString();
    const { data: lapsedSlot, error: lapsedSlotError } = await admin
      .from("call_slots")
      .insert({
        parent_id: pid, due_at: lapsedDue, expires_at: new Date(realNow.getTime() - 60 * 60000).toISOString(),
        kind: "medication", med_names: ["GoneMed"], state: "pending",
      })
      .select("id")
      .single();
    if (lapsedSlotError || !lapsedSlot) throw new Error(`lapsed-slot fixture failed: ${lapsedSlotError?.message}`);
    await materializeSlots(admin as never, parent, { ...ctx, medications: [], sourcesComplete: true }, realNow);
    const { data: lapsedStill } = await admin.from("call_slots").select("state").eq("id", lapsedSlot!.id).maybeSingle();
    check(
      "reconciliation does not delete a lapsed slot before it has been reported",
      lapsedStill !== null,
      "the slot was deleted as an orphan — a missed check-in with no calls row and no alert"
    );
    // And it must then be reported, not just survive.
    await expireLapsedSlots(admin as never, parent, realNow);
    const { data: lapsedMsgs } = await admin
      .from("messages")
      .select("id")
      .eq("parent_id", pid)
      .eq("fingerprint", tooLateFingerprint(lapsedDue));
    check(
      "that lapsed slot is then reported to the family",
      (lapsedMsgs ?? []).length > 0,
      `${(lapsedMsgs ?? []).length} messages`
    );

    // Control: an empty plan really does clear a still-live pending slot, so the check
    // above is testing the expires_at bound and not an inert code path.
    check(
      "a genuinely empty plan does clear still-live pending slots (control)",
      (await slotsOf(pid)).filter((s) => s.state === "pending").length === 0,
      "reconciliation did nothing — the check above proves nothing"
    );
    // Put the day back for the checks that follow.
    await materializeSlots(admin as never, parent, ctx, realNow);
    slots = await slotsOf(pid);

    // ---- an incomplete source read must not DIAL either ----
    // materializeSlots refusing to reconcile is only half of it. ctx.medications defaulted
    // to [] resolves every snapshot to no medications, so dispatching would ring the parent
    // and never mention the pills — and the slot is consumed, the calls row is unique on
    // (parent_id, scheduled_for) so it can't be re-dialled, and the webhook records no
    // missed doses. The call reads as a clean check-in that asked nothing.
    const dueBefore = (await slotsOf(pid)).filter((s) => s.state === "pending").length;
    const { triggered: triggeredBlind, ok: blindOk } = await dispatchDueSlots(admin as never, parent, { ...ctx, medications: [], sourcesComplete: false }, realNow);
    const dueAfter = (await slotsOf(pid)).filter((s) => s.state === "pending").length;
    check(
      "an incomplete source read places no call, consumes no slot, and reports itself degraded",
      triggeredBlind === 0 && dueAfter === dueBefore && blindOk === false,
      `${triggeredBlind} calls, ${dueBefore} -> ${dueAfter} pending, ok=${blindOk}`
    );

    // ---- an appointment reminder yields to a call that already covered the day ----
    const apptDue = new Date(realNow.getTime() - 10 * 60000).toISOString();
    const { data: apptSlot } = await admin
      .from("call_slots")
      .insert({
        parent_id: pid, due_at: apptDue, expires_at: new Date(realNow.getTime() + 60 * 60000).toISOString(),
        kind: "appointment", med_names: [], state: "pending",
      })
      .select("id")
      .single();
    // A distinct scheduled_for: calls is unique on (parent_id, scheduled_for) and the
    // lapsed-slot check above already wrote a row three hours back. Checked, not assumed —
    // a null here crashes the run after the assertions it feeds.
    const coveringAt = new Date(realNow.getTime() - 2 * 60 * 60000).toISOString();
    const { data: covering, error: coveringError } = await admin
      .from("calls")
      .insert({ parent_id: pid, scheduled_for: coveringAt, status: "completed", called_at: coveringAt })
      .select("id")
      .single();
    if (coveringError || !covering) throw new Error(`covering-call fixture failed: ${coveringError?.message}`);
    await dispatchDueSlots(admin as never, parent, ctx, realNow);
    const { data: apptAfter } = await admin.from("call_slots").select("state, call_id").eq("id", apptSlot!.id).single();
    check(
      "an appointment reminder yields to the call that already covered the day",
      // 'dispatched' against the covering call, NOT 'cancelled'. Cancelled means "we stopped
      // being responsible" and materialisation revives it, which looped revive -> claim ->
      // cancel every tick and eventually expired into "the appointment reminder didn't go
      // out" for a day the parent was called and the appointment was named on that call.
      apptAfter!.state === "dispatched" && apptAfter!.call_id === covering.id,
      `state=${apptAfter!.state} call_id=${apptAfter!.call_id} (expected dispatched, linked to ${covering.id})`
    );

    // It must also survive the next materialisation rather than being revived into a
    // pending slot that later reports itself missed.
    await materializeSlots(admin as never, parent, ctx, realNow);
    const { data: apptStill } = await admin.from("call_slots").select("state").eq("id", apptSlot!.id).single();
    check(
      "a covered appointment slot is not revived by the next tick",
      apptStill!.state === "dispatched",
      `state=${apptStill!.state} — revived, and it will expire into a false "reminder didn't go out" alert`
    );

    // Control: with nothing covering the day it must NOT be cancelled, or the check above is
    // satisfied by a dispatch that cancels every appointment slot unconditionally.
    await admin.from("calls").delete().eq("id", covering.id);
    await admin.from("call_slots").update({ state: "pending" }).eq("id", apptSlot!.id);
    await admin.from("calls").delete().eq("parent_id", pid).in("status", ["scheduled", "in_progress"]);
    await dispatchDueSlots(admin as never, parent, ctx, realNow);
    const { data: apptUncovered } = await admin.from("call_slots").select("state, call_id").eq("id", apptSlot!.id).single();
    check(
      "an appointment reminder IS acted on when nothing covered the day (control)",
      // The positive, not "not cancelled": a dispatch that bailed early for an unrelated
      // reason leaves the slot pending, and "not cancelled" passes on that too.
      apptUncovered!.state === "dispatched",
      `state=${apptUncovered!.state} call_id=${apptUncovered!.call_id} — dispatch did not act, so the check above proves nothing`
    );

    // ---- a slot revived after a hold must pick up edits made during it ----
    // The medication reconcile loop reads a snapshot taken before the revive, so a slot
    // revived on the same tick used to keep the list it was cancelled with: a caregiver who
    // adds a dose while paused resumes into an evening call that never mentions it.
    const { data: revivableSlot } = await admin
      .from("call_slots")
      .select("id, due_at")
      .eq("parent_id", pid)
      .eq("state", "pending")
      .gt("due_at", realNow.toISOString())
      .limit(1)
      .maybeSingle();
    if (revivableSlot) {
      await admin.from("call_slots").update({ state: "cancelled", med_names: ["StaleMed"] }).eq("id", revivableSlot.id);
      await materializeSlots(admin as never, parent, ctx, realNow);
      const { data: revivedSlot } = await admin.from("call_slots").select("state, med_names").eq("id", revivableSlot.id).single();
      check(
        "a revived slot picks up medication edits made during the hold",
        revivedSlot!.state === "pending" && !revivedSlot!.med_names.includes("StaleMed"),
        `state=${revivedSlot!.state} med_names=${JSON.stringify(revivedSlot!.med_names)} — the call would name the wrong medication`
      );
    } else {
      check("a revived slot picks up medication edits made during the hold", false, "no future pending slot to exercise this");
    }

    // ---- a call that never connected must not cancel the appointment reminder ----
    // lib/dial.ts stamps called_at on a provider error so the row enters the retry pipeline.
    // Reading that column as "already rung today" meant a Vapi outage on the morning slot
    // silently cancelled the afternoon's reminder — one column, two meanings, the defect
    // 0032 exists for.
    const failedDue = new Date(realNow.getTime() - 4 * 60 * 60000).toISOString();
    const { data: neverConnected } = await admin
      .from("calls")
      .insert({ parent_id: pid, scheduled_for: failedDue, status: "no_answer", called_at: failedDue, dial_attempted_at: failedDue })
      .select("id")
      .single();
    const apptDue2 = new Date(realNow.getTime() - 5 * 60000).toISOString();
    const { data: apptSlot2 } = await admin
      .from("call_slots")
      .insert({
        parent_id: pid, due_at: apptDue2, expires_at: new Date(realNow.getTime() + 60 * 60000).toISOString(),
        kind: "appointment", med_names: [], state: "pending",
      })
      .select("id")
      .single();
    await admin.from("calls").delete().eq("parent_id", pid).in("status", ["scheduled", "in_progress"]);
    await dispatchDueSlots(admin as never, parent, ctx, realNow);
    const { data: apptVsFailed } = await admin.from("call_slots").select("state, call_id").eq("id", apptSlot2!.id).single();
    check(
      "a call that never connected does not count as covering the day",
      apptVsFailed!.state === "dispatched" && apptVsFailed!.call_id !== neverConnected!.id,
      `state=${apptVsFailed!.state} call_id=${apptVsFailed!.call_id} — a Vapi outage silently cancelled the appointment reminder`
    );
    await admin.from("calls").delete().eq("id", neverConnected!.id);

    // ---- a stranded 'scheduled' row is not proof anyone was spoken to ----
    // A post-dial write failure leaves a row stuck at 'scheduled' — the exact condition the
    // stale reaper exists for. Counting that as "already rung today" parked the afternoon's
    // appointment slot against a call that never happened: never dispatched, never expired,
    // reminder gone with no alert, while the reaper abandoned that same row as a miss.
    // calls_parent_active_unique allows only one active row per parent, and earlier checks
    // leave one behind. Cleared first, and the insert is checked rather than assumed —
    // a null here would otherwise crash the run after the assertions it guards.
    await admin.from("calls").delete().eq("parent_id", pid).in("status", ["scheduled", "in_progress"]);
    const { data: strandedCall, error: strandedCallError } = await admin
      .from("calls")
      .insert({ parent_id: pid, scheduled_for: new Date(realNow.getTime() - 6 * 60 * 60000).toISOString(), status: "scheduled" })
      .select("id")
      .single();
    if (strandedCallError || !strandedCall) throw new Error(`stranded fixture failed: ${strandedCallError?.message}`);
    const apptDue3 = new Date(realNow.getTime() - 4 * 60000).toISOString();
    const { data: apptSlot3 } = await admin
      .from("call_slots")
      .insert({
        parent_id: pid, due_at: apptDue3, expires_at: new Date(realNow.getTime() + 60 * 60000).toISOString(),
        kind: "appointment", med_names: [], state: "pending",
      })
      .select("id")
      .single();
    await dispatchDueSlots(admin as never, parent, ctx, realNow);
    const { data: apptVsStranded } = await admin.from("call_slots").select("state, call_id").eq("id", apptSlot3!.id).single();
    check(
      "a row stranded at 'scheduled' does not count as covering the day",
      apptVsStranded!.call_id !== strandedCall.id && apptVsStranded!.state !== "dispatched",
      `state=${apptVsStranded!.state} call_id=${apptVsStranded!.call_id} — parked against a call that never happened`
    );
    await admin.from("call_slots").delete().eq("id", apptSlot3!.id);
    await admin.from("calls").delete().eq("id", strandedCall.id);

    // ---- cancel ----
    await cancelPendingSlots(admin as never, pid, "harness", realNow);
    slots = await slotsOf(pid);
    check("cancelling clears pending slots", slots.filter((s) => s.state === "pending").length === 0, JSON.stringify(slots.map((s) => s.state)));
    check(
      "cancelling does not rewrite slots already accounted for (control)",
      slots.find((s) => s.id === elapsed.id)!.state === "expired",
      "an expired slot was overwritten as cancelled"
    );

    // ---- resume must give the day back ----
    // The slots above were just cancelled. A caregiver who pauses at 10:00 and resumes at
    // 11:00 gets a tick that re-plans the day; if materialising can't re-open a cancelled
    // row, this evening's check-in is never dialled, never expires and never alerts.
    await materializeSlots(admin as never, parent, ctx, realNow);
    slots = await slotsOf(pid);
    // By due_at, not by id: the empty-plan control above deletes pending rows, so the slot
    // for this time may legitimately be a new row. The identity that matters is the slot
    // time, which is what the unique index is on.
    const revived = slots.find((s) => s.due_at === future.due_at);
    check(
      "re-materialising after a cancel gives the day back (pause then resume)",
      revived?.state === "pending",
      `state=${revived?.state ?? "ROW MISSING"} — the rest of the day stays cancelled and is never called or reported`
    );

    // ---- a slot whose call actually happened must not be reported as missed ----
    // A provider error releases the slot to pending and routes the call into the retry
    // pipeline; a retry can then connect. If expiry only looks at the slot, it reuses the
    // now-completed calls row and texts "check-in was missed" about a call that happened.
    const servedDue = new Date(realNow.getTime() - 30 * 60000).toISOString();
    const { data: servedCall } = await admin
      .from("calls")
      .insert({ parent_id: pid, scheduled_for: servedDue, status: "completed", called_at: servedDue, dial_attempted_at: servedDue })
      .select("id")
      .single();
    await admin.from("call_slots").insert({
      parent_id: pid, due_at: servedDue, expires_at: new Date(realNow.getTime() - 60000).toISOString(),
      kind: "medication", med_names: ["EarlyMed"], state: "pending",
    });
    await expireLapsedSlots(admin as never, parent, realNow);
    const servedFp = tooLateFingerprint(servedDue);
    const { data: servedMsgs } = await admin.from("messages").select("id").eq("parent_id", pid).eq("fingerprint", servedFp);
    check(
      "a slot whose call actually connected is NOT reported as missed",
      (servedMsgs ?? []).length === 0,
      `${(servedMsgs ?? []).length} messages — the family was told a completed check-in was missed`
    );
    await admin.from("calls").delete().eq("id", servedCall!.id);

    // ---- a slot stranded mid-dispatch must be recovered ----
    // The claim writes 'dispatched' before dialing. If the invocation dies in between, the
    // slot matches neither the dispatch query nor the expiry query: no call, no alert, no
    // trace. `calls` rows got a reaper for exactly this; slots need one too.
    const strandedDue = new Date(realNow.getTime() - 20 * 60000).toISOString();
    const { data: stranded } = await admin
      .from("call_slots")
      .insert({
        parent_id: pid, due_at: strandedDue, expires_at: new Date(realNow.getTime() + 60 * 60000).toISOString(),
        kind: "medication", med_names: ["EarlyMed"], state: "dispatched", call_id: null,
        updated_at: new Date(realNow.getTime() - 30 * 60000).toISOString(),
      })
      .select("id")
      .single();
    await dispatchDueSlots(admin as never, parent, ctx, realNow);
    const { data: strandedAfter } = await admin.from("call_slots").select("state,call_id").eq("id", stranded!.id).single();
    check(
      "a slot stranded in dispatched is recovered, not lost",
      strandedAfter!.state !== "dispatched" || strandedAfter!.call_id !== null,
      `state=${strandedAfter!.state} call_id=${strandedAfter!.call_id} — stuck forever, invisible to both queries`
    );

  } finally {
    if (pid) {
      await admin.from("call_slots").delete().eq("parent_id", pid);
      for (const t of ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) {
        await admin.from(t).delete().eq("parent_id", pid);
      }
      await admin.from("parents").delete().eq("id", pid);
    }
    await admin.from("sms_opt_ins").delete().in("phone", [CG_PHONE, PARENT_PHONE, CONTACT_PHONE]);
    await admin.from("caregivers").delete().eq("id", cg);
    await admin.auth.admin.deleteUser(cg);
    console.log("\ncleaned up probe household.");
  }

  console.log(`\n${pass}/${pass + fail} queue checks passed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
