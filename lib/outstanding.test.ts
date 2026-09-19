import { describe, expect, it } from "vitest";
import { outstandingMedsToday } from "./outstanding";
import type { Call } from "@/types/db";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-09-11T02:00:00Z"); // 19:00 PDT on the 10th

function call(hourPdt: number, meds: { confirmed?: string[]; missed?: string[] }, status = "completed"): Call {
  return {
    id: `c${hourPdt}`,
    parent_id: "p1",
    scheduled_for: new Date(Date.UTC(2026, 8, 10 + (hourPdt >= 17 ? 0 : 0), hourPdt + 7, 0, 0)).toISOString(),
    status,
    meds_confirmed: meds,
  } as unknown as Call;
}

describe("outstandingMedsToday", () => {
  it("carries a dose missed this morning into the evening", () => {
    expect(outstandingMedsToday([call(9, { missed: ["Lisinopril"] })], TZ, NOW)).toEqual(["Lisinopril"]);
  });

  it("drops it once a later call confirms it", () => {
    const calls = [call(9, { missed: ["Lisinopril"] }), call(12, { confirmed: ["Lisinopril"] })];
    expect(outstandingMedsToday(calls, TZ, NOW)).toEqual([]);
  });

  it("is case-insensitive, because the model is not consistent about it", () => {
    const calls = [call(9, { missed: ["lisinopril"] }), call(12, { confirmed: ["Lisinopril"] })];
    expect(outstandingMedsToday(calls, TZ, NOW)).toEqual([]);
  });

  it("re-raises a dose that was taken earlier and missed again later", () => {
    // Order matters: the later call is the current state, not the first one seen.
    const calls = [call(9, { confirmed: ["Metformin"] }), call(12, { missed: ["Metformin"] })];
    expect(outstandingMedsToday(calls, TZ, NOW)).toEqual(["Metformin"]);
  });

  it("ignores calls that never connected", () => {
    // A slot that expired unrung leaves a failed row with no medication data. Treating its
    // scheduled_meds as missed would nag about a dose nobody ever asked her about.
    expect(outstandingMedsToday([call(9, { missed: ["Lisinopril"] }, "failed")], TZ, NOW)).toEqual([]);
  });

  it("ignores yesterday", () => {
    const old = { ...call(9, { missed: ["Lisinopril"] }) } as Call;
    (old as { scheduled_for: string }).scheduled_for = "2026-09-05T16:00:00Z";
    expect(outstandingMedsToday([old], TZ, NOW)).toEqual([]);
  });
});
