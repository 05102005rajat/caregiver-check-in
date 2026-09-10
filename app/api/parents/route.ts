import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SetupFormPayload } from "@/types/db";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const payload = (await request.json()) as SetupFormPayload;

  if (!payload.caregiver?.name || !payload.parent?.name || !payload.parent?.phone) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const db = createAdminClient();

  // caregivers.id is the same value as auth.uid() so RLS policies can match on it directly.
  const { error: caregiverError } = await db.from("caregivers").upsert({
    id: user.id,
    email: user.email,
    name: payload.caregiver.name,
    phone: payload.caregiver.phone,
  });
  if (caregiverError) {
    return NextResponse.json({ error: caregiverError.message }, { status: 500 });
  }

  // v1 supports one parent per caregiver (spec section 10). Resubmitting the form
  // updates that same parent + fully replaces their meds/appointments/contacts,
  // rather than creating a second parent (and duplicate scheduled calls).
  const { data: parent, error: parentError } = await db
    .from("parents")
    .upsert(
      {
        caregiver_id: user.id,
        name: payload.parent.name,
        phone: payload.parent.phone,
        timezone: payload.parent.timezone,
        preferred_voice: payload.parent.assistant_name,
      },
      { onConflict: "caregiver_id" }
    )
    .select()
    .single();
  if (parentError || !parent) {
    return NextResponse.json({ error: parentError?.message ?? "Failed to create parent" }, { status: 500 });
  }

  const parentId = parent.id as string;

  const [delMeds, delAppts, delContacts] = await Promise.all([
    db.from("medications").delete().eq("parent_id", parentId),
    db.from("appointments").delete().eq("parent_id", parentId),
    db.from("family_contacts").delete().eq("parent_id", parentId),
  ]);
  for (const { error } of [delMeds, delAppts, delContacts]) {
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (payload.medications.length > 0) {
    const { error } = await db.from("medications").insert(
      payload.medications.map((m) => ({
        parent_id: parentId,
        name: m.name,
        dose: m.dose || null,
        time_of_day: m.time_of_day,
        notes: m.notes || null,
      }))
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (payload.appointments.length > 0) {
    const { error } = await db.from("appointments").insert(
      payload.appointments.map((a) => ({
        parent_id: parentId,
        title: a.title,
        starts_at: new Date(a.starts_at).toISOString(),
        location: a.location || null,
        notes: a.notes || null,
      }))
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (payload.family_contacts.length > 0) {
    const { error } = await db.from("family_contacts").insert(
      payload.family_contacts.map((c) => ({
        parent_id: parentId,
        name: c.name,
        phone: c.phone,
        role: c.role,
        notify_on_miss: c.notify_on_miss,
        notify_on_concern: c.notify_on_concern,
      }))
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: rulesError } = await db.from("escalation_rules").upsert({
    parent_id: parentId,
    retry_after_minutes: payload.rules.retry_after_minutes,
    max_retries: payload.rules.max_retries,
  });
  if (rulesError) {
    return NextResponse.json({ error: rulesError.message }, { status: 500 });
  }

  return NextResponse.json({ parent_id: parentId }, { status: 201 });
}
