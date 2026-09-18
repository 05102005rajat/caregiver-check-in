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
    // --- Deletion actually deletes. The privacy policy promises this, and the failure
    //     mode is silent: telling someone their parent's transcripts are gone while rows
    //     remain is worse than not offering deletion at all. Mirrors the ordered sweep in
    //     /api/parents/delete rather than trusting cascade rules.
    // escalation_rules is keyed by parent_id with no `id` column, so selecting "id" there
    // errors, leaves count undefined, and the table silently drops out of the residue
    // total — the one check whose entire job is "nothing was left behind".
    const CLEANUP_TABLES = ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"] as const;
    let deleteErrors = 0;
    for (const t of CLEANUP_TABLES) {
      const { error: delError } = await admin.from(t).delete().eq("parent_id", parentA);
      if (delError) deleteErrors += 1;
    }
    await admin.from("parents").delete().eq("id", parentA);

    let residue = 0;
    for (const t of CLEANUP_TABLES) {
      const { count, error: countError } = await admin.from(t).select("parent_id", { count: "exact", head: true }).eq("parent_id", parentA);
      // An unreadable table can't be claimed as empty.
      if (countError) residue += 1;
      residue += count ?? 0;
    }
    const { count: parentsLeft } = await admin.from("parents").select("id", { count: "exact", head: true }).eq("id", parentA);
    const fullyDeleted = residue === 0 && (parentsLeft ?? 0) === 0 && deleteErrors === 0;
    check(
      "deleting a household leaves no transcripts or other rows behind",
      fullyDeleted,
      `${residue} child row(s), ${parentsLeft} parent row(s) remain, ${deleteErrors} delete error(s)`
    );
    // Only skip the finally-sweep when everything really did go. Clearing this
    // unconditionally would abandon probe rows in exactly the failure case where they exist.
    if (fullyDeleted) parentA = "";

  } finally {
    // Clean up regardless of outcome — a failed run must not leave probe households behind.
    if (parentA) {
      await admin.from("messages").delete().eq("parent_id", parentA);
      await admin.from("calls").delete().eq("parent_id", parentA);
      for (const t of ["medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) {
        await admin.from(t).delete().eq("parent_id", parentA);
      }
      await admin.from("parents").delete().eq("id", parentA);
    }
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
