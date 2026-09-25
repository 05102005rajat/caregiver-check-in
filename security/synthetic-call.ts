/**
 * Drive a transcript through the real webhook without dialling anyone.
 *
 *   source .env.local
 *   npx tsx security/synthetic-call.ts "AI: Hi Nora...\nUser: I'm fine."
 *
 * Exercises extraction, the concern rules, dedupe, the all-clear, and the voicemail and
 * abort paths — everything downstream of a transcript — for the price of one extraction. A
 * real dial costs ~$0.30 of Vapi credit, rings an elderly person, and tests the one part of
 * the stack we do not own.
 *
 * It builds its OWN throwaway household and deletes it in a `finally`. The first version did
 * neither, and both omissions were dangerous in the same way:
 *
 *   - `parents.select().limit(1)` took whatever row came back, and production holds exactly
 *     one household: the maintainer's own parent. A "synthetic" clean call would have texted
 *     a real caregiver a real all-clear, and a concerning one a real "needs a look".
 *   - the cleanup sat after an `await fetch(...)` with no `finally` and an uncaught `main()`.
 *     The default target is localhost, so the likeliest failure of all — dev server not
 *     running — left an `in_progress` row on that real household. Ten minutes later the
 *     stale reaper treats it as a vanished check-in and RE-DIALS. That exact sequence, from
 *     a different cleanup, placed two unwanted calls and is why this file exists.
 *
 * So: non-routable +1202555 numbers, SendGrid suppressed, own household, `finally`.
 */
import "./no-email";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.VAPI_WEBHOOK_SECRET;
if (!URL_ || !SERVICE || !SECRET) {
  console.error("Missing env — `source .env.local` first.");
  process.exit(1);
}
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const target = process.env.WEBHOOK_URL ?? "http://localhost:3111/api/vapi/webhook";
const n = () => `+1202555${Math.floor(1000 + Math.random() * 9000)}`;
// Held, not called inline, so the teardown can clear sms_opt_ins for them — the other three
// harnesses all do this, and a row recordCarrierOptOut writes for a number nobody kept is
// permanent.
const CG_PHONE = n(), PARENT_PHONE = n(), CONTACT_PHONE = n();

async function main() {
  // `"...\nUser: ..."` in sh/zsh is a literal backslash-n, so argv would be ONE line —
  // hasParentResponse then sees no speaker turn, noResponse fires, and every run takes the
  // "check-in didn't happen" branch instead of the one being tested. Normalised rather than
  // documented around, because the documented form was the broken one.
  const transcript = (process.argv[2] ?? "").replace(/\\n/g, "\n");
  if (!transcript) {
    console.error('Usage: npx tsx security/synthetic-call.ts "AI: ...\\nUser: ..."');
    console.error("Optional: WEBHOOK_URL=https://elderly-sigma.vercel.app/api/vapi/webhook");
    process.exit(1);
  }

  const email = `synthetic-${Date.now()}@example.invalid`;
  const { data: u, error: ue } = await db.auth.admin.createUser({ email, password: `pw-${Date.now()}`, email_confirm: true });
  if (ue || !u.user) throw new Error(`createUser: ${ue?.message}`);
  const cg = u.user.id;
  let pid = "";

  try {
    const { data, error } = await db.rpc("save_parent_setup", {
      p_caregiver_id: cg, p_caregiver_email: email, p_caregiver_name: "Synthetic CG",
      p_caregiver_phone: CG_PHONE, p_parent_name: "Nora", p_parent_phone: PARENT_PHONE,
      p_parent_timezone: "America/Los_Angeles", p_assistant_name: "Rosie",
      p_medications: [{ name: "Aspirin", dose: "81 mg", time_of_day: "10:00", notes: "", description: "small round orange pill", start_date: "", end_date: "" }],
      p_appointments: [],
      p_family_contacts: [{ name: "Kid", phone: CONTACT_PHONE, email: "", role: "son", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true }],
      p_watch_items: [], p_retry_after_minutes: 30, p_max_retries: 2,
    });
    if (error || !data) throw new Error(`save_parent_setup: ${error?.message}`);
    pid = data as string;
    // Consent, or the webhook discards the transcript on the no-consent path and returns
    // HTTP 200 having stored nothing. Checked, because "(silent)" is a legitimate result of
    // this harness — a broken probe would otherwise be indistinguishable from a clean call.
    const { error: consentError } = await db
      .from("parents")
      .update({ consent_given_at: new Date().toISOString() })
      .eq("id", pid);
    if (consentError) throw new Error(`could not grant consent: ${consentError.message}`);

    const vapiId = `synthetic-${Date.now()}`;
    const { data: row, error: ce } = await db
      .from("calls")
      .insert({
        parent_id: pid, scheduled_for: new Date().toISOString(), status: "in_progress",
        called_at: new Date().toISOString(), dial_attempted_at: new Date().toISOString(),
        // Empty by default so the all-clear branch is REACHABLE. With a dose seeded here,
        // unaccountedMedications reports it for any transcript that does not name it, and
        // the header's claim that this harness exercises the all-clear would be false for
        // its own example. Pass SYNTHETIC_MEDS=Aspirin to exercise the medication path.
        vapi_call_id: vapiId,
        scheduled_meds: (process.env.SYNTHETIC_MEDS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
      })
      .select("id")
      .single();
    if (ce) throw new Error(`could not create the call row: ${ce.message}`);

    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": SECRET as string },
      body: JSON.stringify({
        message: { type: "end-of-call-report", endedReason: "customer-ended-call", call: { id: vapiId }, artifact: { transcript } },
      }),
    });

    // Checked, not merely printed. A 401 from a stale VAPI_WEBHOOK_SECRET, a 500, or a
    // WEBHOOK_URL pointing at something that answers but isn't this route all produce
    // `messages: 0` / `(silent)` and exit 0 — identical to a clean call that correctly stayed
    // quiet, which is a legitimate result here. The same hazard the consent check above
    // closes, one step later in the same function.
    if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    // And these two reads decide what the run REPORTS, so a dropped error turns a failed
    // lookup into "the webhook did nothing" — fail-open in exactly the direction the
    // teardown below argues against.
    const { data: after, error: afterError } = await db.from("calls").select("status,mood,summary,concerns,requests,meds_confirmed").eq("id", row!.id).single();
    if (afterError) throw new Error(`could not read the call back: ${afterError.message}`);
    const { data: msgs, error: msgsError } = await db.from("messages").select("channel,status,recipient,body").eq("call_id", row!.id);
    if (msgsError) throw new Error(`could not read the messages: ${msgsError.message}`);
    console.log(`webhook: HTTP ${res.status}`);
    console.log(`mood=${after?.mood}  concerns=${JSON.stringify(after?.concerns)}  requests=${JSON.stringify(after?.requests)}`);
    console.log(`meds: ${JSON.stringify(after?.meds_confirmed)}`);
    console.log(`summary: ${after?.summary ?? "(none)"}`);
    console.log(`\nmessages: ${msgs?.length ?? 0}`);
    for (const m of msgs ?? []) console.log(`  [${m.channel}/${m.status} → ${m.recipient}]  ${String(m.body).replace(/\n/g, " ⏎ ")}`);
    if (!msgs?.length) console.log("  (silent)");
  } finally {
    // Unconditional, AND verified. A throwaway household left behind has consent, a
    // medication and an `in_progress` call: the scheduler materialises a slot for it and the
    // stale reaper acts on the call, daily, forever. Printing "deleted" without checking is
    // the same defect one level up — a cleanup that silently did not happen, and a line
    // saying it did.
    const failures: string[] = [];
    const attempt = async (label: string, run: () => PromiseLike<{ error: unknown }>) => {
      const { error } = await run();
      if (error) failures.push(`${label}: ${(error as { message?: string })?.message ?? String(error)}`);
    };
    if (pid) {
      await attempt("call_slots", () => db.from("call_slots").delete().eq("parent_id", pid));
      for (const t of ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) {
        await attempt(t, () => db.from(t).delete().eq("parent_id", pid));
      }
      await attempt("parents", () => db.from("parents").delete().eq("id", pid));
    }
    await attempt("sms_opt_ins", () => db.from("sms_opt_ins").delete().in("phone", [CG_PHONE, PARENT_PHONE, CONTACT_PHONE]));

    // The claim is only worth making if the row is actually gone — and "we could not find
    // out" is not "it is gone". Discarding this error made the check fail OPEN: a read that
    // errored left `count` undefined, `?? 0` read as zero rows, and the harness printed
    // "throwaway household deleted" and exited 0 over a household that may still be there
    // with consent, a medication and an in_progress call for the reaper to re-dial. Exactly
    // the defect this block was added to catch, one level up in the same block.
    //
    // Searched by CAREGIVER, not by `pid`. `pid` is only set if the RPC's response came back;
    // a dropped response or a client timeout on a call that already COMMITTED leaves a real
    // household behind with `pid` still empty — every delete above is then skipped by
    // `if (pid)`, and an id-based count would look at a sentinel UUID, find nothing, and let
    // the harness announce that nothing was created. The caregiver id exists before the RPC
    // is issued, so it finds the household in exactly the case the id cannot.
    // BEFORE the caregiver is deleted, not after. `parents.caregiver_id` is
    // `on delete cascade` (0001_init.sql:13), so deleting the caregiver row takes any
    // surviving household with it — a count issued afterwards can only ever be zero unless
    // that delete itself errored, which `failures` already reports. Read after the cascade,
    // this check could not fail, and a check that cannot fail is the thing this file's
    // header is about.
    const { count, error: countError } = await db
      .from("parents")
      .select("id", { count: "exact", head: true })
      .eq("caregiver_id", cg);
    if (countError) failures.push(`could not confirm the parent row is gone: ${countError.message}`);

    // Now the cascade parent, which cleans up anything the count just caught.
    await attempt("caregivers", () => db.from("caregivers").delete().eq("id", cg));
    const { error: userError } = await db.auth.admin.deleteUser(cg);
    if (userError) failures.push(`auth user: ${userError.message}`);
    // `!pid` too: if save_parent_setup threw, the count above read a sentinel UUID, found
    // nothing and would have printed "deleted" about a household that never existed. The
    // whole value of this line is that it is trustworthy, so it may not be printed on a run
    // that never got far enough to have anything to delete.
    if (failures.length > 0 || countError || (count ?? 0) > 0) {
      // Deliberately ahead of the !pid branch. `failures` can be non-empty WITH `pid` empty —
      // the sms_opt_ins, caregivers and auth-user deletes all run outside `if (pid)` — and a
      // real failure must not be swallowed by the reassuring line below.
      console.error(`\nTEARDOWN FAILED — rows may be left behind (parent ${pid || "id unknown"}, caregiver ${cg}).`);
      for (const f of failures) console.error(`  ${f}`);
      if ((count ?? 0) > 0) console.error(`  ${count} parent row(s) still readable for this caregiver`);
      process.exitCode = 1;
    } else if (!pid) {
      // Setup did not hand back an id, so this run cannot say whether a household was ever
      // created — only that none is readable for this caregiver now. Say exactly that. An
      // earlier draft claimed "no household was created", which a mutation disproved in one
      // run: the RPC HAD committed, and the row was gone because deleting the caregiver
      // cascades to parents, not because nothing existed. Both end safe, and the difference
      // matters the day only one of them is true. `main().catch` reports the real error.
      console.error("\nno rows remain for this caregiver — nothing left behind");
    } else {
      console.log("\nthrowaway household deleted");
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
