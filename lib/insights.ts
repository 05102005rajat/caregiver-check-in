import { warrantsAttention } from "@/lib/alerting";
import type { Call } from "@/types/db";

/**
 * The product question a caregiver actually has every morning is "what changed about
 * Mom?", not "what happened on the call?". A clean check-in should tell them nothing;
 * these are the differences worth surfacing against the recent baseline.
 */
export interface Change {
  kind: "new_concern" | "missed_medication" | "mood_decline" | "repeat_concern";
  detail: string;
}

const DECLINED_MOODS = new Set(["low", "concerning"]);

function medsOf(call: Call, key: "confirmed" | "missed"): string[] {
  const meds = call.meds_confirmed as { confirmed?: string[]; missed?: string[] } | null;
  return (meds?.[key] ?? []).map((m) => m.toLowerCase());
}

/**
 * Differences between `latest` and the calls before it (most-recent-first, and expected
 * to already be scoped to a recent window — a week or so — by the caller).
 *
 * Deliberately conservative: it only reports things that are genuinely new or repeating,
 * because a "what changed" feed that fires on every normal call is noise, and noise is
 * what makes a caregiver stop reading alerts altogether.
 */
export function describeChanges(latest: Call, previous: Call[]): Change[] {
  const changes: Change[] = [];

  const priorConcerns = new Set(previous.flatMap((c) => (c.concerns ?? []).map((x) => x.toLowerCase())));
  const latestConcerns = latest.concerns ?? [];

  for (const concern of latestConcerns) {
    const seenBefore = priorConcerns.has(concern.toLowerCase());
    changes.push({
      kind: seenBefore ? "repeat_concern" : "new_concern",
      detail: seenBefore ? `${concern} (mentioned before too)` : concern,
    });
  }

  // A medication missed today that they'd been reliably taking is a sharper signal than
  // one they've never confirmed — the caregiver already knows about the latter.
  const previouslyConfirmed = new Set(previous.flatMap((c) => medsOf(c, "confirmed")));
  for (const med of medsOf(latest, "missed")) {
    changes.push({
      kind: "missed_medication",
      detail: previouslyConfirmed.has(med) ? `${med} — normally taken, not confirmed today` : `${med} — not confirmed`,
    });
  }

  // Only flag a decline against an established better baseline, so a parent who always
  // reads as "low" doesn't generate an identical alert every single day.
  if (latest.mood && DECLINED_MOODS.has(latest.mood)) {
    const priorMoods = previous.map((c) => c.mood).filter(Boolean) as string[];
    const wasBetter = priorMoods.length > 0 && priorMoods.every((m) => !DECLINED_MOODS.has(m));
    if (wasBetter) {
      changes.push({ kind: "mood_decline", detail: `Sounded ${latest.mood} — different from recent calls` });
    }
  }

  return changes;
}

/**
 * Stable identifier for "we have already told the family this". Built from the
 * structured facts rather than the alert prose, because Claude rewords the same
 * situation differently on every call — fingerprinting the text would never match, and
 * nothing would ever de-duplicate. Order-insensitive and case-insensitive so
 * ["dizzy","fell"] and ["Fell","Dizzy"] are the same alert.
 */
export function alertFingerprint(kind: string, facts: string[]): string {
  const normalized = [...new Set(facts.map((f) => f.trim().toLowerCase()).filter(Boolean))].sort();
  return `${kind}:${normalized.join("|")}`;
}

/**
 * The fingerprint for "this slot's check-in never happened and is now too late".
 *
 * Four paths can reach that conclusion for the same slot — the scheduler's catch-up
 * cutoff, the stale-scheduled reaper, the appointment-reminder cutoff, and lib/dial.ts
 * refusing the calling window — and they must dedupe against each other or a single
 * missed slot texts the family several times. They previously could not: one built the
 * fingerprint from `scheduledFor.toISOString()` ("…T16:00:00.000Z") and another from the
 * raw Postgres string ("…T16:00:00+00:00"), which is the same instant and a different
 * fingerprint. Normalising in one place is the only way that stays true.
 */
export function tooLateFingerprint(scheduledFor: string | Date): string {
  return alertFingerprint("too-late", [new Date(scheduledFor).toISOString()]);
}

/** Whether the caregiver needs to do anything about this call at all. */
export function needsAttention(call: Call): boolean {
  // Delegates to the shared rule so the dashboard can't disagree with what was texted.
  // It previously ignored mood entirely, so a call that alerted the family because the
  // model returned an unreadable mood rendered here as "doing okay".
  return warrantsAttention({
    concerns: call.concerns ?? [],
    medsMissed: medsOf(call, "missed"),
    mood: call.mood,
    status: call.status,
  });
}
