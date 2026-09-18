import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleAndDial } from "@/lib/dial";
import { CALLING_HOURS_END, CALLING_HOURS_START, describeLocalTime } from "@/lib/callwindow";
import { appointmentsToday, medsDueNow } from "@/lib/schedule";
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
    // The medications due by now, via the same medsDueNow the scheduler uses. This said
    // "exactly as a scheduled call computes them" while calling medsAtLocalTime, which
    // matches time_of_day against the current HH:mm *exactly* — so unless the caregiver
    // happened to press the button on the very minute of a dose, it returned nothing and
    // Rosie never mentioned medication at all. The one button whose job is to let someone
    // verify their setup works was the one that didn't exercise it.
    //
    // Still not "every active medication", which is what the original defect was: at 10am
    // this excludes an 8pm pill, so Rosie can't ask about a dose that isn't due, report it
    // unconfirmed, and text the family "Not taken: ..." about medication that isn't late.
    medsDueNow((medications ?? []) as Medication[], parent.timezone, testCallAt),
    appointmentsToday((appointments ?? []) as Appointment[], parent.timezone),
    testCallAt,
    (watchItems ?? []) as WatchItem[],
    // Not a scheduled obligation: a refusal here is reported to the caregiver watching the
    // response, not texted to the family as a missed check-in.
    "manual"
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
    if (outcome.reason === "already_scheduled") {
      return NextResponse.json(
        { error: "There's already an active call for this parent — wait for it to finish first" },
        { status: 409 }
      );
    }
    // A provider or database failure is not a conflict. Reporting it as one told the
    // caregiver to wait for a call that was never placed — during a Vapi outage, on the
    // button the dashboard banner and the consent-refusal SMS both point at as the way
    // back out of the consent gate.
    return NextResponse.json(
      { error: `We couldn't place the call just now — something went wrong on our side. Please try again in a few minutes.` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
