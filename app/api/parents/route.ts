import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { setupFormSchema } from "@/lib/validation";
import type { Appointment, Caregiver, EscalationRules, FamilyContact, Medication, Parent } from "@/types/db";

/**
 * Loads the caregiver's existing setup, if any, so `/setup` can pre-fill the form instead
 * of always starting blank. This matters because POST fully replaces medications/
 * appointments/family_contacts on every submit (see below) — without pre-filling, any
 * return visit to `/setup` would silently delete everything not manually retyped.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: caregiverRow } = await supabase.from("caregivers").select("*").eq("id", user.id).maybeSingle();
  const { data: parentRow } = await supabase.from("parents").select("*").eq("caregiver_id", user.id).maybeSingle();

  if (!parentRow) {
    return NextResponse.json({ caregiver: caregiverRow ?? null, parent: null });
  }
  const parent = parentRow as Parent;

  const [{ data: meds }, { data: appts }, { data: contacts }, { data: rules }] = await Promise.all([
    supabase.from("medications").select("*").eq("parent_id", parent.id),
    supabase.from("appointments").select("*").eq("parent_id", parent.id),
    supabase.from("family_contacts").select("*").eq("parent_id", parent.id),
    supabase.from("escalation_rules").select("*").eq("parent_id", parent.id).maybeSingle(),
  ]);

  return NextResponse.json({
    caregiver: (caregiverRow as Caregiver | null) ?? null,
    parent,
    medications: (meds ?? []) as Medication[],
    appointments: (appts ?? []) as Appointment[],
    family_contacts: (contacts ?? []) as FamilyContact[],
    rules: (rules as EscalationRules | null) ?? null,
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const json = await request.json();
  const parsed = setupFormSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const payload = parsed.data;

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

  // Capture the previous rows' ids before touching anything. New rows are inserted first;
  // the old ones are only deleted once every insert below has succeeded, so a failure
  // partway through (e.g. medications insert fails) leaves the prior data intact instead
  // of losing appointments/family_contacts that had already been deleted.
  const [oldMeds, oldAppts, oldContacts] = await Promise.all([
    db.from("medications").select("id").eq("parent_id", parentId),
    db.from("appointments").select("id").eq("parent_id", parentId),
    db.from("family_contacts").select("id").eq("parent_id", parentId),
  ]);
  const oldMedIds = (oldMeds.data ?? []).map((r) => r.id as string);
  const oldApptIds = (oldAppts.data ?? []).map((r) => r.id as string);
  const oldContactIds = (oldContacts.data ?? []).map((r) => r.id as string);

  if (payload.medications.length > 0) {
    const { error } = await db.from("medications").insert(
      payload.medications.map((m) => ({
        parent_id: parentId,
        name: m.name,
        dose: m.dose || null,
        time_of_day: m.time_of_day,
        notes: m.notes || null,
        description: m.description || null,
        start_date: m.start_date || null,
        end_date: m.end_date || null,
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
        email: c.email || null,
        role: c.role,
        notify_on_miss: c.notify_on_miss,
        notify_on_concern: c.notify_on_concern,
        sms_opt_in_confirmed: c.sms_opt_in_confirmed,
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

  // Everything new is in. Now it's safe to remove what this resubmission replaced.
  await Promise.all([
    oldMedIds.length > 0 ? db.from("medications").delete().in("id", oldMedIds) : Promise.resolve(),
    oldApptIds.length > 0 ? db.from("appointments").delete().in("id", oldApptIds) : Promise.resolve(),
    oldContactIds.length > 0 ? db.from("family_contacts").delete().in("id", oldContactIds) : Promise.resolve(),
  ]);

  return NextResponse.json({ parent_id: parentId }, { status: 201 });
}
