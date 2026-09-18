import { NextResponse } from "next/server";
import { localInputToInstant } from "@/lib/localdatetime";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeSetupIssues, setupFormSchema } from "@/lib/validation";
import type { Appointment, Caregiver, EscalationRules, FamilyContact, Medication, Parent, WatchItem } from "@/types/db";

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

  const [{ data: meds }, { data: appts }, { data: contacts }, { data: rules }, { data: watch }] = await Promise.all([
    supabase.from("medications").select("*").eq("parent_id", parent.id),
    supabase.from("appointments").select("*").eq("parent_id", parent.id),
    supabase.from("family_contacts").select("*").eq("parent_id", parent.id),
    supabase.from("escalation_rules").select("*").eq("parent_id", parent.id).maybeSingle(),
    supabase.from("watch_items").select("*").eq("parent_id", parent.id),
  ]);

  return NextResponse.json({
    caregiver: (caregiverRow as Caregiver | null) ?? null,
    parent,
    medications: (meds ?? []) as Medication[],
    appointments: (appts ?? []) as Appointment[],
    family_contacts: (contacts ?? []) as FamilyContact[],
    rules: (rules as EscalationRules | null) ?? null,
    watch_items: (watch ?? []) as WatchItem[],
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
    // `issues` is what the form actually shows. `details` is kept for anything reading the
    // old shape, but it was never the problem: the messages were always in the response and
    // the form rendered only `error`, so a caregiver saw "Invalid input" and nothing else.
    const issues = describeSetupIssues(parsed.error);
    return NextResponse.json(
      {
        error: issues.length === 1 ? issues[0] : "Some details need fixing before we can save this.",
        issues,
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }
  const payload = parsed.data;

  const db = createAdminClient();

  // One Postgres transaction (see migration 0013) rather than ~8 sequential round trips:
  // a failure partway through used to be able to leave a parent with new medications but
  // stale contacts, and the old contact deletes silently failed outright whenever a
  // contact had already been notified (FK violation), duplicating them so that person
  // got every later alert twice. p_caregiver_id comes from the authenticated session,
  // never the request body — the same ownership invariant the admin client always needs.
  const { data: parentId, error } = await db.rpc("save_parent_setup", {
    p_caregiver_id: user.id,
    p_caregiver_email: user.email,
    p_caregiver_name: payload.caregiver.name,
    p_caregiver_phone: payload.caregiver.phone,
    p_parent_name: payload.parent.name,
    p_parent_phone: payload.parent.phone,
    p_parent_timezone: payload.parent.timezone,
    p_assistant_name: payload.parent.assistant_name,
    p_medications: payload.medications,
    // The form sends a bare wall-clock string; it has to be resolved in the parent's zone,
    // never the server's. See lib/localdatetime.ts.
    p_appointments: payload.appointments.map((a) => ({
      ...a,
      starts_at: localInputToInstant(a.starts_at, payload.parent.timezone).toISOString(),
    })),
    p_family_contacts: payload.family_contacts,
    p_watch_items: payload.watch_items,
    p_retry_after_minutes: payload.rules.retry_after_minutes,
    p_max_retries: payload.rules.max_retries,
  });

  if (error || !parentId) {
    console.error("save_parent_setup failed", error);
    return NextResponse.json({ error: error?.message ?? "Failed to save setup" }, { status: 500 });
  }

  return NextResponse.json({ parent_id: parentId }, { status: 201 });
}
