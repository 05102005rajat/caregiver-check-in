import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Call, Message, Parent } from "@/types/db";

export const dynamic = "force-dynamic";

const HEARTBEAT_STALE_MINUTES = 15;
const STUCK_CALL_MINUTES = 10;
const LOOKBACK_HOURS = 24;

/**
 * Operator view across every household, for whoever runs the service — deliberately
 * separate from /dashboard, which is scoped to one caregiver's own parent by RLS.
 *
 * Access is gated on an explicit allowlist rather than any property of the account
 * itself, because this reads across every family's data with the service-role client.
 */
function isAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdmin(user?.email)) {
    // Deliberately identical whether or not you're signed in: an operator console
    // shouldn't confirm its own existence to someone who isn't one.
    return (
      <Shell>
        <p className="text-slate-500 text-sm">Not found.</p>
      </Shell>
    );
  }

  const db = createAdminClient();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const [{ data: parentsRows }, { data: callRows }, { data: messageRows }, { data: heartbeatRow }] = await Promise.all([
    db.from("parents").select("*"),
    db.from("calls").select("*").gte("scheduled_for", since).order("scheduled_for", { ascending: false }),
    db.from("messages").select("*").gte("sent_at", since).order("sent_at", { ascending: false }),
    db.from("cron_heartbeat").select("last_tick_at").eq("id", true).maybeSingle(),
  ]);

  const parents = (parentsRows ?? []) as Parent[];
  const calls = (callRows ?? []) as Call[];
  const messages = (messageRows ?? []) as Message[];

  const minutesSinceTick = heartbeatRow?.last_tick_at
    ? (Date.now() - new Date(heartbeatRow.last_tick_at as string).getTime()) / 60000
    : null;
  const cronStale = minutesSinceTick === null || minutesSinceTick > HEARTBEAT_STALE_MINUTES;

  const byStatus = (status: string) => calls.filter((c) => c.status === status).length;
  const stuck = calls.filter(
    (c) => c.status === "in_progress" && c.called_at && (Date.now() - new Date(c.called_at).getTime()) / 60000 > STUCK_CALL_MINUTES
  );
  const failedMessages = messages.filter((m) => m.status === "failed");

  const incidents: string[] = [];
  if (cronStale) {
    incidents.push(
      `Scheduler hasn't run in ${minutesSinceTick === null ? "an unknown amount of time" : `${Math.round(minutesSinceTick)} min`}`
    );
  }
  if (stuck.length > 0) incidents.push(`${stuck.length} call(s) stuck in progress over ${STUCK_CALL_MINUTES} min`);
  if (failedMessages.length > 0) incidents.push(`${failedMessages.length} notification(s) failed to send`);
  if (byStatus("failed") > 0) incidents.push(`${byStatus("failed")} call(s) failed outright`);

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Operations</h1>
        <p className="text-slate-500 mt-1 text-sm">All households · last {LOOKBACK_HOURS}h</p>
      </div>

      <div
        className={`rounded-xl border p-4 mb-6 ${
          incidents.length === 0 ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
        }`}
      >
        {incidents.length === 0 ? (
          <p className="text-sm text-emerald-800">
            ✓ No active incidents. Scheduler ran {minutesSinceTick !== null ? `${Math.round(minutesSinceTick)} min ago` : "—"}.
          </p>
        ) : (
          <ul className="text-sm text-red-800 space-y-1">
            {incidents.map((i) => (
              <li key={i}>⚠ {i}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-6">
        <Stat label="Households" value={parents.length} />
        <Stat label="Calls" value={calls.length} />
        <Stat label="Completed" value={byStatus("completed")} />
        <Stat label="No answer" value={byStatus("no_answer")} />
        <Stat label="Failed" value={byStatus("failed")} tone={byStatus("failed") > 0 ? "bad" : undefined} />
        <Stat label="Alerts" value={messages.length} />
      </div>

      <h2 className="text-sm font-medium text-slate-700 mb-2">Households</h2>
      <div className="space-y-2 mb-6">
        {parents.length === 0 && <p className="text-sm text-slate-400">No households yet.</p>}
        {parents.map((parent) => {
          const theirs = calls.filter((c) => c.parent_id === parent.id);
          const last = theirs[0];
          return (
            <div key={parent.id} className="border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-4 bg-white">
              <div>
                <p className="text-sm font-medium text-slate-900">{parent.name}</p>
                <p className="text-xs text-slate-400">
                  {parent.timezone} · {parent.consent_given_at ? "consented" : "no consent yet"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">
                  {last ? `${last.status} · ${new Date(last.scheduled_for).toLocaleString()}` : `no calls in ${LOOKBACK_HOURS}h`}
                </p>
                <p className="text-xs text-slate-400">{theirs.length} call(s)</p>
              </div>
            </div>
          );
        })}
      </div>

      {failedMessages.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-slate-700 mb-2">Failed notifications</h2>
          <div className="space-y-2">
            {failedMessages.map((m) => (
              <div key={m.id} className="border border-red-200 bg-red-50 rounded-xl p-3">
                <p className="text-xs text-red-800">
                  {m.channel} → {m.recipient ?? "unknown"}
                </p>
                <p className="text-xs text-red-700 mt-1 font-mono break-all">{m.error}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "bad" ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
      <p className={`text-xl font-semibold ${tone === "bad" ? "text-red-800" : "text-slate-900"}`}>{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">{children}</div>
    </div>
  );
}
