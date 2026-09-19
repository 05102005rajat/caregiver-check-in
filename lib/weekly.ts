import { localDayBoundsUtc } from "@/lib/schedule";
import type { Appointment, Call } from "@/types/db";

/**
 * The week, as a handful of facts a caregiver can act on.
 *
 * One call tells you about one morning. The question underneath this product is slower
 * than that — "is Mom doing worse than she was?" — and it is only answerable across days.
 * lib/insights.ts already answers "what changed since the last few calls" for a single
 * call; this answers "what has the week looked like".
 *
 * Deterministic on purpose. Every number here comes from the structured fields the webhook
 * already extracts (concerns, meds_confirmed, mood, status), so it costs nothing per view,
 * says the same thing twice if you reload, and can be unit-tested. Asking a model to
 * summarise a week of summaries would be a second place for it to be wrong.
 *
 * WORDING IS PART OF THE CONTRACT. Every line reports what was SAID on a call — "mentioned
 * dizziness on 2 calls" — never what is true of the person. This product listens to an
 * elderly person and texts their family; the distance between "mentioned feeling dizzy" and
 * "is dizzy" is the distance between a record and a diagnosis, and only the first one is
 * ours to make. `disclaimer` is not decoration, and callers are expected to render it.
 */

export type WeeklyTone = "good" | "neutral" | "watch";

export interface WeeklyLine {
  icon: string;
  text: string;
  tone: WeeklyTone;
}

export interface WeeklySummary {
  /** Local days covered by the window, oldest first. */
  days: number;
  /** Days on which a check-in actually connected. */
  connected: number;
  /** Days a check-in was scheduled for — the denominator of "6 of 7". */
  scheduled: number;
  lines: WeeklyLine[];
  /** Things said on more than one day. Verbatim as the parent's own words, not a verdict. */
  worthChecking: string[];
  /**
   * Null when no call connected this week. The sentence is about the content of calls, so
   * printing it under a panel whose only line is a future appointment claims to be "a
   * record of what was said" about a week in which nothing was said — which is what a brand
   * new household saw on its very first visit.
   */
  disclaimer: string | null;
  /** True when there is nothing to show yet, so callers can skip the whole panel. */
  empty: boolean;
}

export const WEEKLY_WINDOW_DAYS = 7;

export const WEEKLY_DISCLAIMER =
  "This is a record of what was said on the calls, not a medical assessment.";

/** Moods that are worth counting across a week. Matches lib/insights.ts. */
const DECLINED_MOODS = new Set(["low", "concerning"]);

function medsOf(call: Call, key: "confirmed" | "missed"): string[] {
  const meds = call.meds_confirmed as { confirmed?: string[]; missed?: string[] } | null;
  return (meds?.[key] ?? []).filter(Boolean);
}

function localDayKey(instant: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

function weekdayName(instant: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date(instant));
}

/** "dizziness" and "Dizziness " are the same thing said twice, not two things. */
function normalise(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Medication names come back from the extraction model with whatever capitalisation it
 * felt like, so a plain Set produced "lisinopril, metformin, Lisinopril" — the same drug
 * listed twice — the first time this ran against real data. Grouped case-insensitively,
 * displayed with the tidiest spelling actually seen.
 */
function dedupeNames(names: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = byKey.get(key);
    // Prefer a spelling that starts capitalised — these are proper nouns and read wrong
    // lowercase in a sentence a caregiver is meant to act on.
    if (!existing || (/^[a-z]/.test(existing) && /^[A-Z]/.test(name))) byKey.set(key, name);
  }
  return [...byKey.values()];
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function weeklySummary(
  calls: Call[],
  appointments: Appointment[],
  timezone: string,
  now: Date = new Date()
): WeeklySummary {
  const { endUtc } = localDayBoundsUtc(timezone, now);
  const windowStart = new Date(endUtc.getTime() - WEEKLY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const inWindow = calls.filter((c) => {
    const at = new Date(c.scheduled_for);
    return at >= windowStart && at <= endUtc;
  });

  const scheduledDays = new Set(inWindow.map((c) => localDayKey(c.scheduled_for, timezone)));
  // "Connected" means a conversation happened, which is what the caregiver is counting.
  // A row that exists because a slot expired unrung is the opposite of a check-in.
  const connectedCalls = inWindow.filter((c) => c.status === "completed");
  const connectedDays = new Set(connectedCalls.map((c) => localDayKey(c.scheduled_for, timezone)));

  const lines: WeeklyLine[] = [];

  if (scheduledDays.size > 0) {
    const missedDays = scheduledDays.size - connectedDays.size;
    lines.push({
      icon: missedDays === 0 ? "🟢" : "🟠",
      text: `${connectedDays.size} of ${scheduledDays.size} ${plural(scheduledDays.size, "check-in", "check-ins")} completed`,
      tone: missedDays === 0 ? "good" : "watch",
    });
  }

  // Medication, counted by day rather than by call, so two calls on one day don't read as
  // two missed doses.
  const daysWithMissedMeds = new Map<string, Set<string>>();
  const confirmedDays = new Set<string>();
  for (const call of connectedCalls) {
    const day = localDayKey(call.scheduled_for, timezone);
    const missed = medsOf(call, "missed");
    if (missed.length > 0) {
      const bucket = daysWithMissedMeds.get(day) ?? new Set<string>();
      for (const m of missed) bucket.add(m);
      daysWithMissedMeds.set(day, bucket);
    }
    if (medsOf(call, "confirmed").length > 0) confirmedDays.add(day);
  }

  if (daysWithMissedMeds.size > 0) {
    const names = dedupeNames([...daysWithMissedMeds.values()].flatMap((s) => [...s]));
    lines.push({
      icon: "💊",
      text: `${names.join(", ")} not confirmed on ${daysWithMissedMeds.size} ${plural(daysWithMissedMeds.size, "day", "days")}`,
      tone: "watch",
    });
  } else if (confirmedDays.size > 0) {
    lines.push({
      icon: "💊",
      text: `Medication confirmed on all ${confirmedDays.size} ${plural(confirmedDays.size, "day", "days")}`,
      tone: "good",
    });
  }

  // Concerns, counted by the number of DAYS they came up on. Something said once is in the
  // call summary already; something said across days is the pattern a weekly view exists
  // to surface.
  const concernDays = new Map<string, { label: string; days: Set<string> }>();
  for (const call of connectedCalls) {
    const day = localDayKey(call.scheduled_for, timezone);
    for (const concern of call.concerns ?? []) {
      if (!concern.trim()) continue;
      const key = normalise(concern);
      const entry = concernDays.get(key) ?? { label: concern.trim(), days: new Set<string>() };
      entry.days.add(day);
      concernDays.set(key, entry);
    }
  }

  const recurring = [...concernDays.values()]
    .filter((c) => c.days.size > 1)
    .sort((a, b) => b.days.size - a.days.size);
  for (const concern of recurring) {
    lines.push({
      icon: "⚠️",
      // "Mentioned", always. See the note at the top of this file.
      text: `Mentioned ${concern.label} on ${concern.days.size} ${plural(concern.days.size, "call", "calls")}`,
      tone: "watch",
    });
  }

  const lowMoodDays = new Set(
    connectedCalls.filter((c) => c.mood && DECLINED_MOODS.has(c.mood)).map((c) => localDayKey(c.scheduled_for, timezone))
  );
  if (lowMoodDays.size > 1) {
    lines.push({
      icon: "😔",
      text: `Sounded low on ${lowMoodDays.size} of ${connectedDays.size} ${plural(connectedDays.size, "day", "days")}`,
      tone: "watch",
    });
  }

  // Looking forward, not back: the one thing in this panel the caregiver can still act on.
  const upcoming = appointments
    .filter((a) => {
      const at = new Date(a.starts_at);
      return at >= now && at.getTime() <= now.getTime() + WEEKLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  for (const appointment of upcoming) {
    lines.push({
      icon: "📅",
      text: `${appointment.title} on ${weekdayName(appointment.starts_at, timezone)}`,
      tone: "neutral",
    });
  }

  return {
    days: scheduledDays.size,
    connected: connectedDays.size,
    scheduled: scheduledDays.size,
    lines,
    worthChecking: recurring.map((c) => c.label),
    disclaimer: connectedDays.size > 0 ? WEEKLY_DISCLAIMER : null,
    empty: lines.length === 0,
  };
}
