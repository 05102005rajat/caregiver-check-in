/**
 * Adversarial tenant-isolation check.
 *
 * Run deliberately, not in `npm test`: it creates real (throwaway) users against the
 * configured Supabase project and cleans them up afterwards.
 *
 *   npm run security
 *
 * Why this exists: the most sensitive thing in this system is a transcript of an elderly
 * person's conversation, and the boundary protecting it is RLS plus a hand-maintained
 * "derive ownership from the session, never the request body" convention in the routes
 * that use the service-role client. Both are invisible to the type checker and to every
 * other test in the repo.
 *
 * That gap is not hypothetical. A SECURITY DEFINER RPC taking caregiver_id as a parameter
 * was briefly callable with the public anon key, which would have let anyone rewrite
 * another household's parent phone number and redirect their check-in calls. Nothing in
 * CI could have caught it. This can.
 *
 * Every assertion is phrased as an attack: B tries to reach A's data and must fail.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!URL || !ANON || !SERVICE) {
  console.error("Missing Supabase env vars — source .env.local first.");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const results: Array<{ name: string; passed: boolean; detail?: string }> = [];

function check(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : `\n    ${detail}`}`);
}

/** Rows a tenant must never see belonging to another tenant. */
const CHILD_TABLES = ["medications", "appointments", "family_contacts", "watch_items", "calls", "messages"] as const;

async function makeUser(tag: string) {
  const email = `sec-probe-${tag}-${Date.now()}@example.invalid`;
  const password = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

  const session = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await session.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) throw new Error(`signIn failed: ${signInError?.message}`);

  return { id: data.user.id, email, client: session };
}

async function main() {
  console.log("Creating two throwaway caregivers…\n");
  const a = await makeUser("a");
  const b = await makeUser("b");
  let parentA = "";

  try {
    // Caregiver A sets up a household through the same RPC the app uses.
    const { data: pid, error } = await admin.rpc("save_parent_setup", {
      p_caregiver_id: a.id,
      p_caregiver_email: a.email,
      p_caregiver_name: "Probe A",
      p_caregiver_phone: "+15555550101",
      p_parent_name: "Parent A",
      p_parent_phone: "+15555550102",
      p_parent_timezone: "America/Los_Angeles",
      p_assistant_name: "Rosie",
      p_medications: [{ name: "SecretMed", dose: "", time_of_day: "09:00", notes: "", description: "", start_date: "", end_date: "" }],
      // Seeded deliberately: with an empty list the "B cannot read A's appointments"
      // assertion below passed identically with RLS switched off entirely.
      p_appointments: [{ title: "Secret cardiology appt", starts_at: new Date(Date.now() + 86400000).toISOString(), location: "", notes: "" }],
      p_family_contacts: [
        { name: "Contact A", phone: "+15555550103", email: "", role: "son", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true },
        { name: "Orphan A", phone: "+15555550104", email: "", role: "daughter", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true },
        { name: "Revoked A", phone: "+15555550105", email: "", role: "other", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true },
      ],
      p_watch_items: [{ description: "private watch note", always_alert: false }],
      p_retry_after_minutes: 30,
      p_max_retries: 2,
    });
    if (error || !pid) throw new Error(`setup failed: ${error?.message}`);
    parentA = pid as string;

    // A call with a transcript — the most sensitive row in the system.
    const { data: call } = await admin
      .from("calls")
      .insert({ parent_id: parentA, scheduled_for: new Date().toISOString(), status: "completed", transcript: "SECRET TRANSCRIPT", summary: "secret" })
      .select()
      .single();
    await admin.from("messages").insert({ parent_id: parentA, call_id: call!.id, recipient: "+15555550103", body: "secret alert", status: "sent", channel: "sms" });

    console.log("");

    // --- A can see their own data (proves the checks below aren't passing vacuously) ---
    const { data: ownParent } = await a.client.from("parents").select("*").eq("id", parentA);
    check("caregiver A can read their own parent (control)", (ownParent ?? []).length === 1);

    const { data: ownTranscript } = await a.client.from("calls").select("transcript").eq("parent_id", parentA);
    check("caregiver A can read their own transcript (control)", (ownTranscript ?? []).some((c) => c.transcript === "SECRET TRANSCRIPT"));

    // Every child table gets a control read as A. Without these, an RLS change that made a
    // table unreadable by everyone — or a fixture that stopped seeding it — would satisfy
    // the "B sees nothing" assertions below while proving nothing at all.
    for (const table of CHILD_TABLES) {
      const { data, error } = await a.client.from(table).select("*").eq("parent_id", parentA);
      check(
        `caregiver A can read their own ${table} (control)`,
        !error && (data ?? []).length > 0,
        error ? `error: ${error.message}` : `saw 0 rows — fixture seeds none, so the isolation check below is vacuous`
      );
    }

    // --- B must not reach any of it ---
    const { data: stolenParent } = await b.client.from("parents").select("*").eq("id", parentA);
    check("caregiver B cannot read A's parent", (stolenParent ?? []).length === 0, `saw ${(stolenParent ?? []).length} row(s)`);

    for (const table of CHILD_TABLES) {
      const { data } = await b.client.from(table).select("*").eq("parent_id", parentA);
      check(`caregiver B cannot read A's ${table}`, (data ?? []).length === 0, `saw ${(data ?? []).length} row(s)`);
    }

    // Reading a transcript by call id is the specific attack worth naming.
    const { data: stolenTranscript } = await b.client.from("calls").select("transcript").eq("id", call!.id);
    check("caregiver B cannot read A's transcript by call id", (stolenTranscript ?? []).length === 0);

    // --- B must not modify it either. RLS makes an unauthorized UPDATE affect 0 rows
    //     rather than error, so verify the value actually didn't change. ---
    await b.client.from("parents").update({ phone: "+19999999999" }).eq("id", parentA);
    const { data: afterUpdate } = await admin.from("parents").select("phone").eq("id", parentA).single();
    check("caregiver B cannot change A's parent phone (call redirection)", afterUpdate?.phone === "+15555550102", `phone is now ${afterUpdate?.phone}`);

    await b.client.from("parents").delete().eq("id", parentA);
    const { data: afterDelete } = await admin.from("parents").select("id").eq("id", parentA);
    check("caregiver B cannot delete A's parent", (afterDelete ?? []).length === 1);

    await b.client.from("medications").delete().eq("parent_id", parentA);
    const { data: medsLeft } = await admin.from("medications").select("id").eq("parent_id", parentA);
    check("caregiver B cannot delete A's medications", (medsLeft ?? []).length === 1);

    // --- The privilege-escalation path that was actually exploitable ---
    const { error: rpcAsB } = await b.client.rpc("save_parent_setup", {
      p_caregiver_id: a.id,
      p_caregiver_email: a.email,
      p_caregiver_name: "HIJACKED",
      p_caregiver_phone: "+15555550000",
      p_parent_name: "HIJACKED",
      p_parent_phone: "+19999999999",
      p_parent_timezone: "America/Los_Angeles",
      p_assistant_name: "Rosie",
      p_medications: [],
      p_appointments: [],
      p_family_contacts: [],
      p_watch_items: [],
      p_retry_after_minutes: 30,
      p_max_retries: 2,
    });
    const { data: afterRpc } = await admin.from("parents").select("name, phone").eq("id", parentA).single();
    check(
      "an authenticated caregiver cannot hijack another household via save_parent_setup",
      rpcAsB !== null && afterRpc?.name === "Parent A" && afterRpc?.phone === "+15555550102",
      `rpc error: ${rpcAsB?.message ?? "NONE — call succeeded"}; parent is now ${afterRpc?.name} / ${afterRpc?.phone}`
    );

    // --- Anonymous (the key that ships in the browser bundle) ---
    const anon = createClient(URL, ANON, { auth: { persistSession: false } });
    const { data: anonParents } = await anon.from("parents").select("*");
    check("anonymous cannot list parents", (anonParents ?? []).length === 0, `saw ${(anonParents ?? []).length} row(s)`);

    const { data: anonCalls } = await anon.from("calls").select("transcript");
    check("anonymous cannot list transcripts", (anonCalls ?? []).length === 0, `saw ${(anonCalls ?? []).length} row(s)`);

    const { error: anonRpc } = await anon.rpc("save_parent_setup", {
      p_caregiver_id: a.id,
      p_caregiver_email: a.email,
      p_caregiver_name: "HIJACKED",
      p_caregiver_phone: "+15555550000",
      p_parent_name: "HIJACKED",
      p_parent_phone: "+19999999999",
      p_parent_timezone: "America/Los_Angeles",
      p_assistant_name: "Rosie",
      p_medications: [],
      p_appointments: [],
      p_family_contacts: [],
      p_watch_items: [],
      p_retry_after_minutes: 30,
      p_max_retries: 2,
    });
    const { data: afterAnon } = await admin.from("parents").select("phone").eq("id", parentA).single();
    check(
      "anonymous cannot call save_parent_setup (the hole that was live)",
      anonRpc !== null && afterAnon?.phone === "+15555550102",
      `rpc error: ${anonRpc?.message ?? "NONE — call succeeded"}; phone is now ${afterAnon?.phone}`
    );
    // Give B a real household that SHARES a family-contact number with A. Without this,
    // "deleting one household does not touch another" compared 0 to 0 and would have passed
    // unchanged if delete_parent_household emptied the entire database — which matters
    // because that function deletes sms_opt_ins by bare phone number, with no household
    // scoping (0021 keys that table on phone alone). Two adult children listing the same
    // sibling is the ordinary case, and it is the case this check exists to protect.
    const SHARED_CONTACT_PHONE = "+15555550103";
    // Used only by A, so deleting A must clean them up. SHARED_CONTACT_PHONE above is the
    // negative case; these are the positive one that makes it meaningful.
    const ORPHANED_CONTACT_PHONE = "+15555550104";
    const REVOKED_CONTACT_PHONE = "+15555550105";
    const { data: bParentId, error: bSetupError } = await admin.rpc("save_parent_setup", {
      p_caregiver_id: b.id,
      p_caregiver_email: b.email,
      p_caregiver_name: "Caregiver B",
      p_caregiver_phone: "+15555550201",
      p_parent_name: "Parent B",
      p_parent_phone: "+15555550202",
      p_parent_timezone: "America/Los_Angeles",
      p_assistant_name: "Rosie",
      p_medications: [],
      p_appointments: [],
      p_family_contacts: [
        { name: "Shared Sibling", phone: SHARED_CONTACT_PHONE, email: "", role: "son", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true },
      ],
      p_watch_items: [],
      p_retry_after_minutes: 30,
      p_max_retries: 2,
    });
    if (bSetupError || !bParentId) throw new Error(`B setup failed: ${bSetupError?.message}`);

    // A consent record for the shared number, belonging to B as much as to A.
    await admin.from("sms_opt_ins").upsert(
      {
        phone: SHARED_CONTACT_PHONE,
        name: "Shared Sibling",
        consented_at: new Date().toISOString(),
        consent_text: "evidence that must survive A's deletion",
        consent_version: "probe",
      },
      { onConflict: "phone" }
    );

    await admin.from("sms_opt_ins").upsert(
      [
        {
          phone: ORPHANED_CONTACT_PHONE,
          name: "Orphan A",
          consented_at: new Date().toISOString(),
          consent_text: "consent nobody else relies on",
          consent_version: "probe",
        },
        {
          phone: REVOKED_CONTACT_PHONE,
          name: "Revoked A",
          consented_at: new Date().toISOString(),
          consent_text: "consent later withdrawn",
          consent_version: "probe",
          revoked_at: new Date().toISOString(),
        },
      ],
      { onConflict: "phone" }
    );

    // Control: both rows exist before the deletion. Without this, "the row is gone" is also
    // what you see when the fixture never seeded it — which is precisely how the deletion
    // check in this file used to compare 0 to 0 and prove nothing.
    const { count: seededBefore } = await admin
      .from("sms_opt_ins")
      .select("phone", { count: "exact", head: true })
      .in("phone", [ORPHANED_CONTACT_PHONE, REVOKED_CONTACT_PHONE]);
    check("consent rows for A-only numbers exist before deletion (control)", (seededBefore ?? 0) === 2, `${seededBefore ?? 0} of 2 seeded`);

    const { count: bHouseholdsBefore } = await admin
      .from("parents")
      .select("id", { count: "exact", head: true })
      .eq("caregiver_id", b.id);

    // --- Deletion actually deletes, through the code that actually runs. ---
    //
    // This used to issue its own service-role DELETEs and then count the rows it had just
    // deleted, which is near-tautological: it proved Postgres can delete, not that the
    // product's deletion path works. It now calls delete_parent_household (0028), the one
    // transaction /api/parents/delete invokes, so a regression there fails here.
    const { error: delRpcError } = await admin.rpc("delete_parent_household", {
      p_caregiver_id: a.id,
      p_parent_id: parentA,
    });

    const CLEANUP_TABLES = ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"] as const;
    let residue = 0;
    for (const t of CLEANUP_TABLES) {
      // escalation_rules is keyed by parent_id with no `id` column, so selecting "id" there
      // errors, leaves count undefined, and the table silently drops out of the residue
      // total — the one check whose entire job is "nothing was left behind".
      const { count, error: countError } = await admin.from(t).select("parent_id", { count: "exact", head: true }).eq("parent_id", parentA);
      if (countError) residue += 1; // an unreadable table can't be claimed as empty
      residue += count ?? 0;
    }
    const { count: parentsLeft } = await admin.from("parents").select("id", { count: "exact", head: true }).eq("id", parentA);
    check(
      "delete_parent_household leaves no transcripts or other rows behind",
      !delRpcError && residue === 0 && (parentsLeft ?? 0) === 0,
      `rpc error: ${delRpcError?.message ?? "none"}; ${residue} child row(s), ${parentsLeft ?? 0} parent row(s) left`
    );

    // The caregiver's own record holds their name, phone and email. "Delete everything"
    // leaving it behind was silent retention the UI never mentioned.
    const { count: caregiverLeft } = await admin.from("caregivers").select("id", { count: "exact", head: true }).eq("id", a.id);
    check(
      "deleting a household also removes the caregiver's own details",
      (caregiverLeft ?? 0) === 0,
      `${caregiverLeft ?? 0} caregiver row(s) left`
    );

    // It must NOT delete another household on the way past.
    const { count: bParentLeft } = await admin.from("parents").select("id", { count: "exact", head: true }).eq("caregiver_id", b.id);
    check(
      "deleting one household does not touch another",
      (bHouseholdsBefore ?? 0) === 1 && (bParentLeft ?? 0) === 1,
      `caregiver B had ${bHouseholdsBefore ?? 0} parent(s), now has ${bParentLeft ?? 0} (both must be 1, or this check proves nothing)`
    );

    // The sharp edge: sms_opt_ins has no household scoping, so deleting A must not take
    // B's consent evidence for a number they both use.
    const { data: sharedOptIn } = await admin
      .from("sms_opt_ins")
      .select("consent_text, consented_at")
      .eq("phone", SHARED_CONTACT_PHONE)
      .maybeSingle();
    check(
      "deleting a household leaves another household's consent record for a shared number",
      Boolean(sharedOptIn?.consent_text) && Boolean(sharedOptIn?.consented_at),
      sharedOptIn ? "row present but consent evidence was stripped" : "row was deleted outright"
    );

    // The other half of the same rule, and the half nothing asserted.
    //
    // Everything above proves deletion leaves a SHARED number's consent alone. On its own
    // that is satisfied just as well by a delete_parent_household that never touches
    // sms_opt_ins at all — so a regression removing the cleanup entirely would have passed
    // the whole suite. These two check the positive direction: a number nobody else uses
    // does get cleaned up, and a carrier-confirmed opt-out survives as a stripped tombstone
    // rather than being dropped (dropping it would let a future household text a number
    // whose owner sent STOP, which is the compliance failure 0020/0021 exist to prevent).
    const { data: orphanOptIn } = await admin
      .from("sms_opt_ins")
      .select("phone")
      .eq("phone", ORPHANED_CONTACT_PHONE)
      .maybeSingle();
    check(
      "deleting a household removes a consent record no surviving household uses",
      orphanOptIn === null,
      orphanOptIn ? "row survived — consent evidence for a deleted household is retained indefinitely" : ""
    );

    const { data: revokedOptIn } = await admin
      .from("sms_opt_ins")
      .select("phone, revoked_at, consent_text, name, consented_at")
      .eq("phone", REVOKED_CONTACT_PHONE)
      .maybeSingle();
    check(
      "a carrier-confirmed opt-out survives deletion as a stripped tombstone",
      Boolean(revokedOptIn?.revoked_at) &&
        revokedOptIn?.consent_text === null &&
        revokedOptIn?.name === null &&
        revokedOptIn?.consented_at === null,
      revokedOptIn
        ? `revoked_at=${revokedOptIn.revoked_at} consent_text=${JSON.stringify(revokedOptIn.consent_text)} name=${JSON.stringify(revokedOptIn.name)}`
        : "row was deleted outright — this number can be texted again by a future household"
    );

    // B's own caregiver row must survive too.
    const { count: bCaregiverLeft } = await admin.from("caregivers").select("id", { count: "exact", head: true }).eq("id", b.id);
    check("deleting a household leaves the other caregiver's record", (bCaregiverLeft ?? 0) === 1, `${bCaregiverLeft ?? 0} row(s)`);

    // Only skip the finally-sweep when everything really did go. Clearing this
    // unconditionally would abandon probe rows in exactly the failure case where they exist.
    if (!delRpcError && residue === 0 && (parentsLeft ?? 0) === 0) parentA = "";

  } finally {
    // Clean up regardless of outcome — a failed run must not leave probe households behind.
    // Both households now, since B has a real one (it is what makes the cross-tenant
    // deletion check non-vacuous), plus the shared opt-in row that check depends on.
    const { data: probeParents } = await admin.from("parents").select("id").in("caregiver_id", [a.id, b.id]);
    for (const row of probeParents ?? []) {
      const pid = row.id as string;
      await admin.from("messages").delete().eq("parent_id", pid);
      await admin.from("calls").delete().eq("parent_id", pid);
      for (const t of ["medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) {
        await admin.from(t).delete().eq("parent_id", pid);
      }
      await admin.from("parents").delete().eq("id", pid);
    }
    await admin.from("sms_opt_ins").delete().in("phone", ["+15555550103", "+15555550104", "+15555550105"]);
    await admin.from("caregivers").delete().in("id", [a.id, b.id]);
    await admin.auth.admin.deleteUser(a.id);
    await admin.auth.admin.deleteUser(b.id);
    console.log("\nCleaned up probe users and data.");
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} isolation checks passed`);
  if (failed.length > 0) {
    console.log("\nFAILING — tenant isolation is broken:");
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
