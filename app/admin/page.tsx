import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditVapiAssistants } from "@/lib/vapi-audit";
import { buildIncidents } from "@/lib/admin-incidents";
import { type AssistantAudit, type CheckState } from "@/lib/vapi-config";
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

  // The Vapi audit runs alongside the database reads rather than after them, so its latency
  // overlaps theirs instead of being added to them.
  //
  // Stated honestly, because an earlier version of this comment claimed more than it
  // delivers: this does NOT stop a slow Vapi delaying the page. `await Promise.all` still
  // gates the whole render on its slowest member, so during a Vapi outage an operator waits
  // out the 8s timeout before seeing whether the scheduler ran. Overlapping ~100ms of
  // Supabase reads saves ~100ms. Actually decoupling them needs a <Suspense> boundary around
  // the panel, which is a deliberate follow-up, not something this comment should pretend is
  // already done.
  //
  // Still inside the handler and still AFTER the allowlist gate above: this reads the Vapi
  // API key and reports the voice assistant's configuration, and that gate is the only
  // thing between it and an anonymous request.
  const [{ data: parentsRows }, { data: callRows }, { data: messageRows }, { data: heartbeatRow }, vapi] =
    await Promise.all([
      db.from("parents").select("*"),
      db.from("calls").select("*").gte("scheduled_for", since).order("scheduled_for", { ascending: false }),
      db.from("messages").select("*").gte("sent_at", since).order("sent_at", { ascending: false }),
      db.from("cron_heartbeat").select("last_tick_at").eq("id", true).maybeSingle(),
      auditVapiAssistants(),
    ]);

  const parents = (parentsRows ?? []) as Parent[];
  const calls = (callRows ?? []) as Call[];
  const messages = (messageRows ?? []) as Message[];

  const minutesSinceTick = heartbeatRow?.last_tick_at
    ? (Date.now() - new Date(heartbeatRow.last_tick_at as string).getTime()) / 60000
    : null;

  const byStatus = (status: string) => calls.filter((c) => c.status === status).length;
  const stuck = calls.filter(
    (c) => c.status === "in_progress" && c.called_at && (Date.now() - new Date(c.called_at).getTime()) / 60000 > STUCK_CALL_MINUTES
  );
  const failedMessages = messages.filter((m) => m.status === "failed");
  // Connected, transcribed, but never summarised: the shape an extraction outage leaves.
  const unprocessed = calls.filter((c) => c.status === "completed" && c.transcript && !c.summary);

  // Assembled in lib/admin-incidents.ts so it can be tested. Inline here, nothing could
  // reach the one line that decides whether this page breaks silence at all.
  const incidents = buildIncidents({
    minutesSinceTick,
    staleAfterMinutes: HEARTBEAT_STALE_MINUTES,
    stuckCalls: stuck.length,
    stuckAfterMinutes: STUCK_CALL_MINUTES,
    failedMessages: failedMessages.length,
    failedCalls: byStatus("failed"),
    unprocessedCalls: unprocessed.length,
    vapi,
  });

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

      <h2 className="text-sm font-medium text-slate-700 mb-2">Voice assistant configuration</h2>
      <p className="text-xs text-slate-400 mb-2">
        Read live from Vapi on every load. These settings live only in the Vapi dashboard, which renders an unset
        field and a grey placeholder identically — so read this, not that.
      </p>
      <div className="space-y-2 mb-6">
        {vapi.audits.length === 0 && (
          // Otherwise the heading and "read live from Vapi on every load" sit above nothing,
          // claiming a read that never happened. The banner carries the reason; this keeps
          // the panel's own claim honest.
          <p className="text-xs text-slate-400">No assistant ids configured — nothing was read. See the incidents above.</p>
        )}
        {vapi.audits.map((audit) => (
          <AuditCard key={audit.id} audit={audit} />
        ))}
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

function AuditCard({ audit }: { audit: AssistantAudit }) {
  const tone = !audit.verified
    ? "border-amber-200 bg-amber-50"
    : audit.checks.some((c) => c.state === "bad")
      ? "border-red-200 bg-red-50"
      : "border-slate-200 bg-white";
  return (
    <div className={`border rounded-xl p-3 ${tone}`}>
      <p className="text-sm font-medium text-slate-900">
        {audit.label}
        {audit.name && <span className="text-slate-400 font-normal"> · {audit.name}</span>}
      </p>
      <ul className="mt-2 space-y-1">
        {audit.checks.map((c) => (
          <li key={c.key} className="text-xs flex gap-2">
            <span className="shrink-0">{mark(c.state)}</span>
            <span className={c.state === "bad" ? "text-red-800" : c.state === "unknown" ? "text-amber-800" : "text-slate-600"}>
              {c.label} — {c.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "unknown" is never a tick. A monitor that looks green when it failed to look is worse
 *  than no monitor: it turns an outage into a reassurance. */
function mark(state: CheckState): string {
  return state === "ok" ? "\u2713" : state === "bad" ? "\u26a0" : "?";
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
