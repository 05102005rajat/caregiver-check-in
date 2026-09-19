import { localDayBoundsUtc } from "@/lib/schedule";
import type { Call } from "@/types/db";

/**
 * Medications from earlier calls today that were never confirmed as taken.
 *
 * Without this, each call knows only about its own slot. A dose missed at 09:00 is reported
 * to the family and then never mentioned to the person again — so the 18:00 call asks about
 * the evening tablet while the morning one sits untouched on the side, and nobody says
 * anything about it to the one person who could still do something.
 *
 * A name drops off the list the moment any later call confirms it, so someone who takes it
 * at eleven is not asked about it again all day.
 */
export function outstandingMedsToday(calls: Call[], timezone: string, now: Date = new Date()): string[] {
  const { startUtc, endUtc } = localDayBoundsUtc(timezone, now);

  // Oldest first, so a later confirmation overrides an earlier miss rather than the reverse.
  const today = calls
    .filter((c) => {
      const at = new Date(c.scheduled_for);
      return at >= startUtc && at <= endUtc && c.status === "completed";
    })
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  const state = new Map<string, { name: string; outstanding: boolean }>();
  for (const call of today) {
    const meds = call.meds_confirmed as { confirmed?: string[]; missed?: string[] } | null;
    for (const name of meds?.missed ?? []) {
      if (name?.trim()) state.set(name.trim().toLowerCase(), { name: name.trim(), outstanding: true });
    }
    for (const name of meds?.confirmed ?? []) {
      const key = name?.trim().toLowerCase();
      if (key && state.has(key)) state.set(key, { name: state.get(key)!.name, outstanding: false });
    }
  }

  return [...state.values()].filter((m) => m.outstanding).map((m) => m.name);
}
