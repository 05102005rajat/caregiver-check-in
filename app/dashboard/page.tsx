import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { describeChanges, needsAttention } from "@/lib/insights";
import type { Call, Message, Parent } from "@/types/db";
import CallRow from "./CallRow";
import PauseControl from "./PauseControl";
import DangerZone from "./DangerZone";
import TestCallButton from "./TestCallButton";

export const dynamic = "force-dynamic";

const HEARTBEAT_STALE_MINUTES = 15;
const STUCK_CALL_MINUTES = 10;
// How far back "normal for them" is measured from when deciding what counts as a change.
const BASELINE_CALLS = 7;

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Shell>
        <p className="text-slate-500">
          You need to <Link href="/login" className="underline">sign in</Link> to view this page.
        </p>
      </Shell>
    );
  }

  const { data: parentRow } = await supabase
    .from("parents")
    .select("*")
    .eq("caregiver_id", user.id)
    .maybeSingle();
  const parent = parentRow as Parent | null;

  if (!parent) {
    return (
      <Shell>
        <p className="text-slate-500">
          No parent set up yet. <Link href="/setup" className="underline">Finish setup</Link> first.
        </p>
      </Shell>
    );
  }

  const [{ data: callsData }, { data: heartbeatRow }] = await Promise.all([
    supabase
      .from("calls")
      .select("*")
      .eq("parent_id", parent.id)
      .order("scheduled_for", { ascending: false })
      .limit(20),
    supabase.from("cron_heartbeat").select("last_tick_at").eq("id", true).maybeSingle(),
  ]);
  const calls = (callsData ?? []) as Call[];

  // Whether the family was actually reached matters as much as what was said — a
  // caregiver assuming a text went out when it silently failed is the worst outcome here.
  const { data: messageRows } = calls.length
    ? await supabase
        .from("messages")
        .select("*")
        .in(
          "call_id",
          calls.map((c) => c.id)
        )
    : { data: [] };
  const messagesByCall = new Map<string, Message[]>();
  for (const message of (messageRows ?? []) as Message[]) {
    const bucket = messagesByCall.get(message.call_id);
    if (bucket) bucket.push(message);
    else messagesByCall.set(message.call_id, [message]);
  }

  const lastTickAt = heartbeatRow?.last_tick_at ? new Date(heartbeatRow.last_tick_at as string) : null;
  const minutesSinceLastTick = lastTickAt ? (Date.now() - lastTickAt.getTime()) / 60000 : null;
  const cronStale = minutesSinceLastTick === null || minutesSinceLastTick > HEARTBEAT_STALE_MINUTES;

  const stuckCalls = calls.filter((c) => {
    if (c.status !== "in_progress" || !c.called_at) return false;
    return (Date.now() - new Date(c.called_at).getTime()) / 60000 > STUCK_CALL_MINUTES;
  });

  const healthy = !cronStale && stuckCalls.length === 0;

  // The most recent call that actually produced something to report, and the calls before
  // it that establish what's normal for this parent.
  const latestCall = calls.find((c) => c.status === "completed" || c.status === "no_answer" || c.status === "failed") ?? null;
  const baseline = latestCall ? calls.filter((c) => c !== latestCall && c.status === "completed").slice(0, BASELINE_CALLS) : [];
  const changes = latestCall ? describeChanges(latestCall, baseline) : [];
  const attention = latestCall ? needsAttention(latestCall) : false;

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 mt-1">{parent.name}&apos;s check-in history</p>
      </div>

      {/* Mirrors the cron's gate exactly (parents_with_calls, migration 0025): a dial was
          attempted, or one is in flight. The old condition here was status <> 'failed',
          which drifted when the gate moved onto called_at — a parent who never answers and
          exhausts retries ends with every row 'failed' but with called_at set, so the
          scheduler treated them as gated and stopped calling while this banner and its
          recovery button both disappeared. That is exactly the "calls quietly stop and the
          caregiver assumes it's broken" state the banner exists to prevent. */}
      {!parent.consent_given_at &&
        !parent.consent_refused_at &&
        calls.some((c) => c.called_at || c.status === "scheduled" || c.status === "in_progress") && (
        // Without this the caregiver has no way to discover that automatic calls are
        // blocked — they'd just notice calls quietly stopping and assume it was broken.
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-4 text-sm text-amber-900">
          <p className="font-medium">Recording consent not yet given</p>
          <p className="mt-1">
            {parent.name} hasn&apos;t agreed to the call being recorded yet, so automatic check-ins are
            paused until they do. It&apos;s worth speaking to them yourself first — then use the button
            below, and Rosie will ask again at the start of that call.
          </p>
          <TestCallButton parentName={parent.name} />
        </div>
      )}
      {!parent.consent_given_at && parent.consent_refused_at && (
        // A refusal is not the same as "hasn't answered yet": Rosie promised not to ring
        // again, and the scheduler honours that. Saying only "not yet given" here would
        // imply the system is still trying, which it deliberately is not.
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 mb-4 text-sm text-slate-700">
          <p className="font-medium">{parent.name} declined the calls</p>
          <p className="mt-1">
            On{" "}
            {new Date(parent.consent_refused_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}{" "}
            {parent.name} said they&apos;d rather not be recorded, so we stopped calling and haven&apos;t
            rung since. If they change their mind, talk to them first and then use the button below.
          </p>
          <TestCallButton parentName={parent.name} />
        </div>
      )}
      {parent.consent_given_at && (
        <p className="text-xs text-slate-400 mb-4">
          Recording consent given {new Date(parent.consent_given_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}.
        </p>
      )}

      <PauseControl parentName={parent.name} pausedUntil={parent.paused_until} />

      <div className={`rounded-xl border p-5 mb-4 ${attention ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
        {!latestCall ? (
          <p className="text-slate-500 text-sm">No check-ins yet — the first one will show up here.</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-lg font-semibold text-slate-900">
                  {attention ? `${parent.name} may need your attention` : `${parent.name} is doing okay`}
                </p>
                <p className="text-sm text-slate-500 mt-0.5">
                  {latestCall.called_at
                    ? `Last check-in ${new Date(latestCall.called_at).toLocaleString(undefined, {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}`
                    : "Last check-in didn't connect"}
                </p>
              </div>
              <span className="text-2xl leading-none">{attention ? "⚠️" : "✅"}</span>
            </div>

            {latestCall.summary && <p className="text-sm text-slate-600 mt-3">{latestCall.summary}</p>}

            <div className="mt-4 pt-3 border-t border-slate-200/70">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">What changed</p>
              {changes.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Nothing new since the last few check-ins — no action needed.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {changes.map((change, i) => (
                    <li key={i} className="text-sm text-slate-700 flex gap-2">
                      <span aria-hidden>{change.kind === "repeat_concern" ? "↻" : "•"}</span>
                      <span>{change.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <div
        className={`rounded-xl border p-4 mb-6 text-sm ${
          healthy ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
        }`}
      >
        {healthy ? (
          <p>✓ Everything looks healthy. Scheduler last ran {minutesSinceLastTick !== null ? `${Math.round(minutesSinceLastTick)} min ago` : "—"}.</p>
        ) : (
          <div className="space-y-1">
            {cronStale && (
              <p>
                ⚠ Scheduler hasn&apos;t run in{" "}
                {minutesSinceLastTick !== null ? `${Math.round(minutesSinceLastTick)} min` : "an unknown amount of time"} — check the
                external cron pinger.
              </p>
            )}
            {stuckCalls.length > 0 && <p>⚠ {stuckCalls.length} call(s) stuck in-progress for over {STUCK_CALL_MINUTES} minutes.</p>}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {calls.length === 0 && <p className="text-sm text-slate-400">No calls yet.</p>}
        {calls.map((call) => (
          <CallRow key={call.id} call={call} messages={messagesByCall.get(call.id) ?? []} />
        ))}
      </div>

      <DangerZone parentName={parent.name} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
        {children}
      </div>
    </div>
  );
}
