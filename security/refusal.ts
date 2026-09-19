/**
 * Runtime check for the dial path that was terminal and silent.
 *
 *   npm run security:refusal
 *
 * Run deliberately, not in `npm test`: it creates a real (throwaway) household against the
 * configured Supabase project, drives the real dialAndRecord, and cleans up afterwards.
 *
 * Why this exists as a *runtime* check rather than a unit test: the defect was never in a
 * pure function. dialAndRecord correctly refused to ring outside calling hours, marked the
 * row `failed`, and returned — and nothing told anybody. The row then occupied
 * (parent_id, scheduled_for), so every later tick's "too late" branch hit a 23505 and
 * continued without a word. No call, no text, no dashboard row. On a product whose promise
 * is "you only hear from us when something needs attention", that renders to a caregiver as
 * "everything is fine". Only exercising the real dial + notify + messages path can show it.
 *
 * Non-routable +1202555 numbers per HANDOVER, so notifyFamilyContacts runs for real —
 * Twilio accepts and never delivers, a `messages` row is still written, and no handset
 * rings.
 *
 * The refusal cases are all decided before triggerVapiCall. The in-hours CONTROL at the end
 * deliberately is not: it exists to prove the gate lets a dial through, so it reaches Vapi
 * and places a real outbound call — to a non-routable number, so nothing is answered, but
 * it is a real provider request and this file should not claim otherwise.
 */
// Must precede every other import: suppresses SendGrid so probe alerts cost nothing.
import "./no-email";
import { createClient } from "@supabase/supabase-js";
import { dialAndRecord } from "@/lib/dial";
import { tooLateFingerprint } from "@/lib/insights";
import { isWithinCallingHours } from "@/lib/callwindow";
import type { Parent } from "@/types/db";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const n = () => `+1202555${Math.floor(1000 + Math.random() * 9000)}`;
const CG_PHONE = n(), PARENT_PHONE = n(), CONTACT_PHONE = n();

const ZONES = ["Pacific/Auckland", "Asia/Tokyo", "Europe/London", "America/Los_Angeles", "Asia/Kolkata", "America/Sao_Paulo"];

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n    ${detail}`}`);
  ok ? pass++ : fail++;
}

async function main() {
  const now = new Date();
  const outside = ZONES.find((z) => !isWithinCallingHours(now, z));
  const inside = ZONES.find((z) => isWithinCallingHours(now, z));
  console.log(`now=${now.toISOString()}  outside-hours zone=${outside}  inside-hours zone=${inside}\n`);
  if (!outside) throw new Error("no zone currently outside calling hours — rerun later");

  const email = `refusal-probe-${Date.now()}@example.invalid`;
  const { data: u, error: uErr } = await admin.auth.admin.createUser({ email, password: `pw-${Date.now()}`, email_confirm: true });
  if (uErr || !u.user) throw new Error(`createUser: ${uErr?.message}`);
  const cg = u.user.id;
  let pid = "";

  try {
    const { data: p, error } = await admin.rpc("save_parent_setup", {
      p_caregiver_id: cg, p_caregiver_email: email, p_caregiver_name: "Refusal Probe",
      p_caregiver_phone: CG_PHONE, p_parent_name: "Refusal Parent", p_parent_phone: PARENT_PHONE,
      p_parent_timezone: outside, p_assistant_name: "Rosie",
      p_medications: [], p_appointments: [],
      p_family_contacts: [{ name: "Probe Contact", phone: CONTACT_PHONE, email: "", role: "son", notify_on_miss: true, notify_on_concern: true, sms_opt_in_confirmed: true }],
      p_watch_items: [], p_retry_after_minutes: 30, p_max_retries: 2,
    });
    if (error || !p) throw new Error(`setup: ${error?.message}`);
    pid = p as string;
    const { data: parentRow } = await admin.from("parents").select("*").eq("id", pid).single();
    const parent = parentRow as Parent;

    const makeCall = async (offsetMin: number) => {
      const scheduledFor = new Date(Date.now() - offsetMin * 60000).toISOString();
      const { data, error: e } = await admin.from("calls").insert({ parent_id: pid, scheduled_for: scheduledFor, status: "scheduled", scheduled_meds: [] }).select().single();
      if (e || !data) throw new Error(`insert call: ${e?.message}`);
      return data as { id: string; scheduled_for: string };
    };
    // Two readers on purpose, and the difference is load-bearing.
    //
    // `msgsFor` counts EVERY channel, and the "control" assertions below use it: "no message
    // was sent" must mean no message on any channel, so an alert that escaped by email only
    // still fails them. Narrowing this would weaken them.
    //
    // `smsFor` is for the positive assertions. security/no-email.ts suppresses SendGrid, so
    // every alert now deterministically writes a `status:'failed', channel:'email'` row —
    // and "at least one message exists" is satisfied by that row alone, with the SMS path
    // removed entirely. security/queue.ts had the identical defect; this is the other half
    // of that audit, which the first pass missed.
    const msgsFor = async (fp: string) => {
      const { data } = await admin.from("messages").select("recipient,body,status,error,channel").eq("parent_id", pid).eq("fingerprint", fp);
      return data ?? [];
    };
    const smsFor = async (fp: string) => (await msgsFor(fp)).filter((m) => m.channel === "sms");
    // Delivered, not merely attempted. A text that Twilio rejected is recorded with
    // `status:'failed'`, so counting SMS rows of any status lets "the family was told" pass
    // over zero delivered messages during an outage — the same gap the dedupe check below
    // closes with `sent.length > 0`, which applies just as much to the headline assertion.
    const deliveredFor = async (fp: string) => (await smsFor(fp)).filter((m) => m.status === "sent");

    // ---- CASE 1: a scheduled check-in refused for the window. Family must be told. ----
    const c1 = await makeCall(5);
    const fp1 = tooLateFingerprint(c1.scheduled_for);
    const out1 = await dialAndRecord(admin as never, c1.id, parent, "Probe Caregiver", [], [], [], "scheduled");
    const { data: row1 } = await admin.from("calls").select("status,called_at").eq("id", c1.id).single();
    const m1 = await deliveredFor(fp1);
    check("refused dial reports outside_calling_hours", !out1.dialed && out1.reason === "outside_calling_hours", JSON.stringify(out1));
    check("refused dial marks the row failed", row1?.status === "failed", JSON.stringify(row1));
    check("refused dial does NOT claim the call was placed", row1?.called_at === null, `called_at=${row1?.called_at}`);
    check("refused scheduled check-in TELLS THE FAMILY (the fix)", m1.length > 0, `${m1.length} delivered texts for fingerprint ${fp1}`);
    const recipients = new Set(m1.map((m) => m.recipient));
    check(
      "both the family contact and the caregiver are told",
      recipients.has(CONTACT_PHONE) && recipients.has(CG_PHONE),
      JSON.stringify([...recipients])
    );
    if (m1[0]) console.log(`    body: ${m1[0].body}`);

    // ---- CASE 1b: a second pass over the same slot must not text again. ----
    // The row is put BACK to 'scheduled' first. Without that, the guarded update matches
    // zero rows, `closed` is null, and the notify block is simply unreachable — so the
    // assertion held even with fingerprint dedupe deleted outright. It proved the guard
    // short-circuits, not that dedupe works, which is the "nine tests that could not fail"
    // shape. Resetting it makes the second pass reach notifyFamilyContacts for real, so
    // only the fingerprint stops the duplicate.
    await admin.from("calls").update({ status: "scheduled" }).eq("id", c1.id);
    const out1b = await dialAndRecord(admin as never, c1.id, parent, "Probe Caregiver", [], [], [], "scheduled");
    const m1b = await smsFor(fp1);
    // Counted per recipient among SUCCESSFUL sends, not as a total.
    //
    // A raw total is wrong in both directions. It was passing as 0 === 0 whenever the alert
    // check above failed — and once that was guarded it started failing for a legitimate
    // reason: a send that errored the first time has status 'failed', which alreadyNotified
    // deliberately does not treat as "they were told", so the next pass retries it and the
    // total climbs by one. That retry is the feature. What must never happen is the same
    // recipient being told twice.
    const sent = m1b.filter((m) => m.status === "sent");
    const sentTwice = Object.entries(
      sent.reduce<Record<string, number>>((acc, m) => {
        acc[m.recipient as string] = (acc[m.recipient as string] ?? 0) + 1;
        return acc;
      }, {})
    ).filter(([, n]) => n > 1);
    // `sent.length > 0` is the anti-vacuity term, and `m1.length > 0` is NOT a substitute for
    // it: m1 counts SMS rows of any status, and a row is recorded as 'failed' for an
    // opt-out, a Twilio outage, or a carrier 21610. If every probe send failed, "nobody was
    // told twice" would be satisfied by nobody being told at all — a green tick over zero
    // successful sends, which is what this whole suite exists to rule out. Same gap the
    // `before > 0` term closes in security/queue.ts, left open in its sibling.
    check(
      "re-running the same refused slot does not tell anyone twice",
      sent.length > 0 && !out1b.dialed && sentTwice.length === 0,
      `${sent.length} successful sends; duplicated for: ${JSON.stringify(sentTwice)} (from ${m1.length} to ${m1b.length} rows)`
    );

    // ---- CASE 2 (CONTROL): a manual test call, refused identically, must NOT alert. ----
    // Without this, "it sent a text" proves only that notify works, not that it fires for
    // the right reason — a version that texted on every refusal would pass case 1 too.
    const c2 = await makeCall(7);
    const fp2 = tooLateFingerprint(c2.scheduled_for);
    const out2 = await dialAndRecord(admin as never, c2.id, parent, "Probe Caregiver", [], [], [], "manual");
    const { data: row2 } = await admin.from("calls").select("status").eq("id", c2.id).single();
    const m2 = await msgsFor(fp2);
    check("manual test call is refused the same way", !out2.dialed && out2.reason === "outside_calling_hours" && row2?.status === "failed");
    check("manual test call does NOT text the family (control)", m2.length === 0, `${m2.length} messages — a test call fabricated a missed check-in`);

    // ---- CONTROL: the same code must NOT refuse inside calling hours ----
    // Without this, every assertion above is satisfied by a dialAndRecord that refuses
    // unconditionally. dial_attempted_at is stamped immediately AFTER the window check and
    // immediately BEFORE triggerVapiCall, so it is exactly the evidence that the gate let
    // this one through — and it holds whether or not Vapi then accepts a non-routable
    // number, so no handset is involved either way.
    if (!inside) {
      // Not a skip. This control is the only thing proving dialAndRecord does not refuse
      // unconditionally, and printing "~ skipped" while the suite exits 0 at 8/8 is the
      // EVAL_REPEATS= shape HANDOVER catalogues: green without having run the thing that
      // matters. The other direction already throws at the top of this file.
      throw new Error("no zone is currently inside calling hours — rerun later; the in-hours control cannot be skipped");
    } else {
      await admin.from("parents").update({ timezone: inside }).eq("id", pid);
      const { data: inHoursRow } = await admin.from("parents").select("*").eq("id", pid).single();
      const c3 = await makeCall(3);
      const out3 = await dialAndRecord(admin as never, c3.id, inHoursRow as Parent, "Probe Caregiver", [], [], [], "scheduled");
      const { data: row3 } = await admin.from("calls").select("status,dial_attempted_at").eq("id", c3.id).single();
      check(
        "inside calling hours the dial is NOT refused (control)",
        // Boolean(), not `!== null`: if the select returns nothing at all — a query error, a
        // deleted row, an RLS change — row3?.dial_attempted_at is undefined, and
        // `undefined !== null` is true, so the one check proving dialAndRecord does not
        // refuse unconditionally would pass having read nothing.
        Boolean(row3) && Boolean(row3?.dial_attempted_at) && !(out3.dialed === false && out3.reason === "outside_calling_hours"),
        `row=${row3 ? "found" : "MISSING"} dial_attempted_at=${row3?.dial_attempted_at} outcome=${JSON.stringify(out3)}`
      );
      const m3 = await msgsFor(tooLateFingerprint(c3.scheduled_for));
      check("a dial that was attempted sends no too-late alert (control)", m3.length === 0, `${m3.length} messages`);
      await admin.from("parents").update({ timezone: outside }).eq("id", pid);
    }

  } finally {
    if (pid) {
      for (const t of ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) await admin.from(t).delete().eq("parent_id", pid);
      await admin.from("parents").delete().eq("id", pid);
    }
    await admin.from("sms_opt_ins").delete().in("phone", [CG_PHONE, PARENT_PHONE, CONTACT_PHONE]);
    await admin.from("caregivers").delete().eq("id", cg);
    await admin.auth.admin.deleteUser(cg);
    console.log("\ncleaned up probe household.");
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
