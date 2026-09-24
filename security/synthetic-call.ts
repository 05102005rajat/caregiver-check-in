/**
 * Drive a call through the real webhook without dialling anyone.
 *
 *   npx tsx security/synthetic-call.ts "AI: Hi Nora...\nUser: I'm fine."
 *
 * Costs nothing but one extraction. A real dial costs ~$0.30 of Vapi credit, rings an
 * elderly person, and exercises the one part of the stack we do not own — so it is for
 * testing the DIAL, and nothing else. Everything downstream of the transcript (extraction,
 * concern rules, dedupe, the all-clear, voicemail and abort handling, the text itself) is
 * reachable from here.
 *
 * Creates its own call row, posts the report, prints what came out, and deletes ONLY the row
 * it made. It never touches a row it did not create — a cleanup scoped by `parent_id` once
 * deleted a live call and the stranded-slot reaper re-dialled a real person twice.
 */
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.VAPI_WEBHOOK_SECRET as string;
if (!URL_ || !SERVICE || !SECRET) {
  console.error("Missing env — source .env.local first.");
  process.exit(1);
}
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const target = process.env.WEBHOOK_URL ?? "http://localhost:3111/api/vapi/webhook";

async function main() {
  const transcript = process.argv[2];
  if (!transcript) {
    console.error('Usage: npx tsx security/synthetic-call.ts "AI: ...\\nUser: ..."');
    process.exit(1);
  }
  const { data: ps } = await db.from("parents").select("id,name").limit(1);
  const parent = ps?.[0];
  if (!parent) {
    console.error("No household exists.");
    process.exit(1);
  }
  // Prefixed so cleanup can be scoped to exactly this row and nothing else.
  const vapiId = `synthetic-${Date.now()}`;
  const { data: row, error } = await db
    .from("calls")
    .insert({
      parent_id: parent.id,
      scheduled_for: new Date().toISOString(),
      status: "in_progress",
      called_at: new Date().toISOString(),
      dial_attempted_at: new Date().toISOString(),
      vapi_call_id: vapiId,
      scheduled_meds: [],
    })
    .select("id")
    .single();
  if (error) {
    console.error(`Could not create the call row: ${error.message}`);
    console.error("A household with an active call blocks this (calls_parent_active_unique).");
    process.exit(1);
  }

  const res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": SECRET },
    body: JSON.stringify({
      message: { type: "end-of-call-report", endedReason: "customer-ended-call", call: { id: vapiId }, artifact: { transcript } },
    }),
  });

  const { data: after } = await db.from("calls").select("status,mood,summary,concerns,requests,meds_confirmed").eq("id", row!.id).single();
  const { data: msgs } = await db.from("messages").select("channel,status,recipient,body").eq("call_id", row!.id);
  console.log(`webhook: HTTP ${res.status}`);
  console.log(`mood=${after?.mood} concerns=${JSON.stringify(after?.concerns)} requests=${JSON.stringify(after?.requests)}`);
  console.log(`summary: ${after?.summary ?? "(none)"}`);
  console.log(`\nmessages: ${msgs?.length ?? 0}`);
  for (const m of msgs ?? []) console.log(`  [${m.channel}/${m.status} → ${m.recipient}] ${String(m.body).replace(/\n/g, " ⏎ ")}`);
  if (!msgs?.length) console.log("  (silent)");

  // Only what this script made.
  await db.from("messages").delete().eq("call_id", row!.id);
  await db.from("calls").delete().eq("id", row!.id);
  console.log("\ncleaned up its own row only");
}
main();
