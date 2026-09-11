import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleAndDial } from "@/lib/dial";
import { appointmentsToday } from "@/lib/schedule";
import type { Appointment, Medication, Parent } from "@/types/db";

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

  const [{ data: medications }, { data: appointments }] = await Promise.all([
    db.from("medications").select("*").eq("parent_id", parent.id).eq("active", true),
    db.from("appointments").select("*").eq("parent_id", parent.id),
  ]);

  const dialed = await scheduleAndDial(
    db,
    parent,
    caregiver?.name ?? "your family",
    (medications ?? []) as Medication[],
    appointmentsToday((appointments ?? []) as Appointment[], parent.timezone),
    new Date()
  );

  if (!dialed) {
    return NextResponse.json(
      { error: "A test call was already placed in the last moment — try again shortly" },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}
