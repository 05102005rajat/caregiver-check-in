import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Call, Parent } from "@/types/db";
import CallRow from "./CallRow";

export const dynamic = "force-dynamic";

const HEARTBEAT_STALE_MINUTES = 15;
const STUCK_CALL_MINUTES = 10;

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

  const lastTickAt = heartbeatRow?.last_tick_at ? new Date(heartbeatRow.last_tick_at as string) : null;
  const minutesSinceLastTick = lastTickAt ? (Date.now() - lastTickAt.getTime()) / 60000 : null;
  const cronStale = minutesSinceLastTick === null || minutesSinceLastTick > HEARTBEAT_STALE_MINUTES;

  const stuckCalls = calls.filter((c) => {
    if (c.status !== "in_progress" || !c.called_at) return false;
    return (Date.now() - new Date(c.called_at).getTime()) / 60000 > STUCK_CALL_MINUTES;
  });

  const healthy = !cronStale && stuckCalls.length === 0;

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 mt-1">{parent.name}&apos;s check-in history</p>
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
          <CallRow key={call.id} call={call} />
        ))}
      </div>
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
