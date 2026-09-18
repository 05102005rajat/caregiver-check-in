import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleAndDial } from "@/lib/dial";
import { CALLING_HOURS_END, CALLING_HOURS_START, describeLocalTime } from "@/lib/callwindow";
import { appointmentsToday, medsAtLocalTime } from "@/lib/schedule";
import type { Appointment, Medication, Parent, WatchItem } from "@/types/db";

/** Fires an immediate real call to the caregiver's own parent, bypassing the schedule. */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const db = createAdminClient();

  const [{ data: caregiver }, { data: parentRow }] = await Promise.all([
    db.from("caregivers").select("name").eq("id", user.id).single(),
    db.from("parents").select("*").eq("caregiver_id", user.id).single(),
  ]);

  if (!parentRow) {
    return NextResponse.json({ error: "No parent found — save the setup form first" }, { status: 404 });
  }
  const parent = parentRow as Parent;

  const [{ data: medications }, { data: appointments }, { data: watchItems }] = await Promise.all([
    db.from("medications").select("*").eq("parent_id", parent.id).eq("active", true),
    db.from("appointments").select("*").eq("parent_id", parent.id),
    // The test call is exactly where a caregiver checks that Rosie asks after the things
    // they told us about, so it must behave identically to a scheduled call.
    db.from("watch_items").select("*").eq("parent_id", parent.id),
  ]);

  const testCallAt = new Date();

  // scheduleAndDial's insert is atomically guarded by a unique index on parent_id for
  // any active (scheduled/in_progress) call, so a double-click or two open tabs can't
  // both place a real Vapi call — one insert wins, the other fails and returns false here.
  const outcome = await scheduleAndDial(
    db,
    parent,
    caregiver?.name ?? "your family",
    // Only the medications actually due around now, exactly as a scheduled call computes
    // them. Passing every active medication meant Rosie asked someone at 10am about their
    // 8pm pills; anything they hadn't taken yet came back as meds_missed, survived the
    // isKnownMed check (it was in this call's own scheduled_meds snapshot), and texted the
    // family "Not taken: ..." for medication that wasn't late at all — a false alarm
    // produced by the button whose whole job is to prove the system works.
    medsAtLocalTime((medications ?? []) as Medication[], testCallAt, parent.timezone),
    appointmentsToday((appointments ?? []) as Appointment[], parent.timezone),
    testCallAt,
    (watchItems ?? []) as WatchItem[]
  );

  if (!outcome.dialed) {
    // Reporting the row insert as success meant that at 21:30 local this returned ok:true
    // and the UI said "Calling now", while dialAndRecord had silently refused the window
    // and no call was placed. This is the documented way out of the consent gate — both the
    // dashboard banner and the refusal SMS point at it — so a caregiver acting on that
    // instruction in the evening was told it worked and nothing happened.
    if (outcome.reason === "outside_calling_hours") {
      return NextResponse.json(
        {
          error: `It's ${describeLocalTime(new Date(), parent.timezone)} where ${parent.name} is. Check-in calls only go out between ${CALLING_HOURS_START}:00 and ${CALLING_HOURS_END}:00 — try again in the morning.`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "There's already an active call for this parent — wait for it to finish first" },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}
