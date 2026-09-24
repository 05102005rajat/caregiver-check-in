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

async function main() {
  const transcript = process.argv[2];
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
      p_caregiver_phone: n(), p_parent_name: "Nora", p_parent_phone: n(),
      p_parent_timezone: "America/Los_Angeles", p_assistant_name: "Rosie",
      p_medications: [{ name: "Aspirin", dose: "81 mg", time_of_day: "10:00", notes: "", description: "small round orange pill", start_date: "", end_date: "" }],
      p_appointments: [],
      p_family_contacts: [{ name: "Kid", phone: n(), email: "", role: "son", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true }],
      p_watch_items: [], p_retry_after_minutes: 30, p_max_retries: 2,
    });
    if (error || !data) throw new Error(`save_parent_setup: ${error?.message}`);
    pid = data as string;
    // Consent, or the webhook discards the transcript and nothing below is exercised.
    await db.from("parents").update({ consent_given_at: new Date().toISOString() }).eq("id", pid);

    const vapiId = `synthetic-${Date.now()}`;
    const { data: row, error: ce } = await db
      .from("calls")
      .insert({
        parent_id: pid, scheduled_for: new Date().toISOString(), status: "in_progress",
        called_at: new Date().toISOString(), dial_attempted_at: new Date().toISOString(),
        vapi_call_id: vapiId, scheduled_meds: ["Aspirin"],
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

    const { data: after } = await db.from("calls").select("status,mood,summary,concerns,requests,meds_confirmed").eq("id", row!.id).single();
    const { data: msgs } = await db.from("messages").select("channel,status,recipient,body").eq("call_id", row!.id);
    console.log(`webhook: HTTP ${res.status}`);
    console.log(`mood=${after?.mood}  concerns=${JSON.stringify(after?.concerns)}  requests=${JSON.stringify(after?.requests)}`);
    console.log(`meds: ${JSON.stringify(after?.meds_confirmed)}`);
    console.log(`summary: ${after?.summary ?? "(none)"}`);
    console.log(`\nmessages: ${msgs?.length ?? 0}`);
    for (const m of msgs ?? []) console.log(`  [${m.channel}/${m.status} → ${m.recipient}]  ${String(m.body).replace(/\n/g, " ⏎ ")}`);
    if (!msgs?.length) console.log("  (silent)");
  } finally {
    // Unconditional. A throwaway household left behind with an `in_progress` call is the
    // thing the stale reaper is built to re-dial.
    if (pid) {
      await db.from("call_slots").delete().eq("parent_id", pid);
      for (const t of ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) {
        await db.from(t).delete().eq("parent_id", pid);
      }
      await db.from("parents").delete().eq("id", pid);
    }
    await db.from("caregivers").delete().eq("id", cg);
    await db.auth.admin.deleteUser(cg);
    console.log("\nthrowaway household deleted");
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
