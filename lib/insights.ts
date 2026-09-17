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

/** Whether the caregiver needs to do anything about this call at all. */
export function needsAttention(call: Call): boolean {
  const missed = medsOf(call, "missed");
  return (call.concerns ?? []).length > 0 || missed.length > 0 || call.status === "failed" || call.status === "no_answer";
}
