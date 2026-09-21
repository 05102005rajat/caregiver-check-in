import { auditIncidents, type AssistantAudit } from "@/lib/vapi-config";

/**
 * Everything the operator banner says, assembled in one pure place.
 *
 * This was inline in app/admin/page.tsx, where nothing could reach it: the Vapi audit had
 * tests proving it *produces* incidents and tests proving `auditIncidents` *formats* them,
 * and nothing at all asserting the page pushes either into the banner. Deleting that push
 * left the whole suite green while an unconfigured callback assistant — the one found in
 * production with recording unset — silently stopped bannering and the page read "No active
 * incidents". It was the last hop of the chain every other test protects.
 *
 * The scheduler, stuck-call and failed-notification lines came along for the ride; none of
 * them had a test either, and on a product whose promise is that silence means everything is
 * fine, the code that decides whether to break silence is the last place to leave untested.
 */
export interface IncidentInput {
  /** null when the heartbeat has never been written or could not be read. */
  minutesSinceTick: number | null;
  staleAfterMinutes: number;
  stuckCalls: number;
  stuckAfterMinutes: number;
  failedMessages: number;
  failedCalls: number;
  /**
   * Calls that connected but have no summary — extraction threw. Its own line because the
   * cause is usually systemic (an expired Anthropic key, an exhausted balance) and the
   * symptom is invisible: the row looks like an ordinary call, and without this the operator
   * console reports "No active incidents" while every check-in that day went unprocessed.
   */
  unprocessedCalls: number;
  vapi: { audits: AssistantAudit[]; incidentNotes: string[] };
}

export function buildIncidents(input: IncidentInput): string[] {
  const incidents: string[] = [];

  // Unknown is stale. A heartbeat that cannot be read is not evidence the scheduler ran,
  // and treating it as healthy is the one direction this product must never fail in.
  const stale = input.minutesSinceTick === null || input.minutesSinceTick > input.staleAfterMinutes;
  if (stale) {
    incidents.push(
      `Scheduler hasn't run in ${
        input.minutesSinceTick === null ? "an unknown amount of time" : `${Math.round(input.minutesSinceTick)} min`
      }`
    );
  }
  if (input.stuckCalls > 0) {
    incidents.push(`${input.stuckCalls} call(s) stuck in progress over ${input.stuckAfterMinutes} min`);
  }
  if (input.failedMessages > 0) incidents.push(`${input.failedMessages} notification(s) failed to send`);
  if (input.failedCalls > 0) incidents.push(`${input.failedCalls} call(s) failed outright`);
  if (input.unprocessedCalls > 0) {
    incidents.push(`${input.unprocessedCalls} call(s) connected but could not be processed — check the extraction API`);
  }

  // Deliberately here and NOT on /api/health: a 503 there means the scheduler is stale and
  // pages whoever is on call. Prompt drift is a real problem but it is not "stop the line at
  // 3am", and overloading the one alarm that has to stay trustworthy is how it gets ignored.
  incidents.push(...auditIncidents(input.vapi.audits));

  // A check that is not running is an incident in its own right. These are a named few — an
  // unconfigured assistant, an unreadable prompt file — not a blanket "every unknown is an
  // incident" rule, which would banner the permanently unresolvable record_consent tool id.
  incidents.push(...input.vapi.incidentNotes);

  return incidents;
}
