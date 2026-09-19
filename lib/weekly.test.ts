import { describe, expect, it } from "vitest";
import { WEEKLY_DISCLAIMER, weeklySummary } from "./weekly";
import type { Appointment, Call } from "@/types/db";

const TZ = "America/Los_Angeles";
// Friday 2026-09-11, 12:00 PDT.
const NOW = new Date("2026-09-11T19:00:00Z");

/** A completed call at 09:00 PDT, `daysAgo` before NOW. */
function call(daysAgo: number, overrides: Partial<Call> = {}): Call {
  const at = new Date(Date.UTC(2026, 8, 11 - daysAgo, 16, 0, 0)); // 09:00 PDT
  return {
    id: `c${daysAgo}-${Math.random()}`,
    parent_id: "p1",
    scheduled_for: at.toISOString(),
    called_at: at.toISOString(),
    dial_attempted_at: at.toISOString(),
    stale_redial_at: null,
    status: "completed",
    vapi_call_id: null,
    retry_count: 0,
    transcript: null,
    summary: null,
    meds_confirmed: null,
    concerns: null,
    requests: null,
    scheduled_meds: null,
    mood: "good",
    created_at: at.toISOString(),
    ...overrides,
  } as Call;
}

function appt(daysAhead: number, title = "Cardiology"): Appointment {
  return {
    id: `a${daysAhead}`,
    parent_id: "p1",
    title,
    starts_at: new Date(NOW.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString(),
    location: null,
    notes: null,
  } as Appointment;
}

const textOf = (s: ReturnType<typeof weeklySummary>) => s.lines.map((l) => l.text);

describe("weeklySummary", () => {
  it("counts completed check-ins against the days one was scheduled", () => {
    const calls = [call(0), call(1), call(2), call(3, { status: "no_answer" })];
    const s = weeklySummary(calls, [], TZ, NOW);
    expect(s.lines[0].text).toBe("3 of 4 check-ins completed");
    expect(s.lines[0].tone).toBe("watch");
  });

  it("reads as good when every scheduled check-in connected", () => {
    const s = weeklySummary([call(0), call(1)], [], TZ, NOW);
    expect(s.lines[0].text).toBe("2 of 2 check-ins completed");
    expect(s.lines[0].tone).toBe("good");
  });

  it("counts two calls on one day as one day, not two", () => {
    // A retry, or a second medication slot. Counting calls instead of days would report
    // "2 of 2" for a single day and inflate every number below it.
    const morning = call(1);
    const evening = call(1, { scheduled_for: new Date("2026-09-11T02:00:00Z").toISOString() });
    const s = weeklySummary([morning, evening], [], TZ, NOW);
    expect(s.lines[0].text).toContain("of 1 check-in");
  });

  it("ignores calls outside the window", () => {
    const s = weeklySummary([call(0), call(30)], [], TZ, NOW);
    expect(s.lines[0].text).toBe("1 of 1 check-in completed");
  });

  it("reports a medication not confirmed, naming it and the number of days", () => {
    const calls = [
      call(0, { meds_confirmed: { confirmed: [], missed: ["Metformin"] } as never }),
      call(1, { meds_confirmed: { confirmed: [], missed: ["Metformin"] } as never }),
      call(2, { meds_confirmed: { confirmed: ["Metformin"], missed: [] } as never }),
    ];
    expect(textOf(weeklySummary(calls, [], TZ, NOW))).toContain("Metformin not confirmed on 2 days");
  });

  it("lists a medication once however the model capitalised it", () => {
    // Found by running this against real call history, not by a test: the extraction model
    // returns "lisinopril" and "Lisinopril" on different days, and a plain Set rendered
    // "lisinopril, metformin, Lisinopril" — the same drug twice, to a caregiver deciding
    // whether to phone their mother.
    const calls = [
      call(0, { meds_confirmed: { confirmed: [], missed: ["lisinopril", "metformin"] } as never }),
      call(1, { meds_confirmed: { confirmed: [], missed: ["Lisinopril"] } as never }),
    ];
    const line = textOf(weeklySummary(calls, [], TZ, NOW)).find((t) => t.includes("not confirmed"))!;
    expect(line).toBe("Lisinopril, metformin not confirmed on 2 days");
  });

  it("says medication was confirmed when nothing was missed", () => {
    const calls = [call(0, { meds_confirmed: { confirmed: ["Lisinopril"], missed: [] } as never })];
    expect(textOf(weeklySummary(calls, [], TZ, NOW))).toContain("Medication confirmed on all 1 day");
  });

  // The point of a weekly view: one mention is already in that call's summary, a pattern
  // across days is what only this panel can show.
  it("surfaces a concern mentioned on more than one day", () => {
    const calls = [
      call(0, { concerns: ["dizziness"] }),
      call(2, { concerns: ["Dizziness"] }),
      call(3, { concerns: ["sore knee"] }),
    ];
    const s = weeklySummary(calls, [], TZ, NOW);
    expect(textOf(s)).toContain("Mentioned dizziness on 2 calls");
    expect(s.worthChecking).toEqual(["dizziness"]);
  });

  it("does not surface a concern mentioned only once", () => {
    const s = weeklySummary([call(0, { concerns: ["sore knee"] })], [], TZ, NOW);
    expect(s.worthChecking).toEqual([]);
    expect(textOf(s).some((t) => t.includes("sore knee"))).toBe(false);
  });

  it("treats the same concern said twice in one day as one day", () => {
    const a = call(1, { concerns: ["dizziness"] });
    const b = call(1, { scheduled_for: new Date("2026-09-11T02:00:00Z").toISOString(), concerns: ["dizziness"] });
    expect(weeklySummary([a, b], [], TZ, NOW).worthChecking).toEqual([]);
  });

  // Wording is part of the contract: this reports what was said, never what is true of the
  // person. A line that reads as a diagnosis is the failure mode.
  it("attributes everything to the call, never to the person", () => {
    const calls = [call(0, { concerns: ["chest pain"] }), call(1, { concerns: ["chest pain"] })];
    const s = weeklySummary(calls, [], TZ, NOW);
    const line = textOf(s).find((t) => t.includes("chest pain"))!;
    expect(line.startsWith("Mentioned ")).toBe(true);
    for (const forbidden of [" has ", " is experiencing", "symptom", "diagnos", "suffers"]) {
      expect(line.toLowerCase()).not.toContain(forbidden);
    }
    expect(s.disclaimer).toBe(WEEKLY_DISCLAIMER);
  });

  it("only reports low mood as a pattern, not from a single call", () => {
    expect(textOf(weeklySummary([call(0, { mood: "low" })], [], TZ, NOW)).some((t) => t.includes("low"))).toBe(false);
    const two = [call(0, { mood: "low" }), call(1, { mood: "concerning" })];
    expect(textOf(weeklySummary(two, [], TZ, NOW)).some((t) => t.startsWith("Sounded low on 2"))).toBe(true);
  });

  it("counts nothing from calls that never connected", () => {
    // A slot that expired unrung leaves a 'failed' row. Reading its (absent) concerns as
    // data would let a scheduler outage look like a quiet week.
    const calls = [call(0, { status: "failed", concerns: ["dizziness"] }), call(1, { status: "failed", concerns: ["dizziness"] })];
    const s = weeklySummary(calls, [], TZ, NOW);
    expect(s.worthChecking).toEqual([]);
    expect(s.lines[0].text).toBe("0 of 2 check-ins completed");
  });

  it("lists an upcoming appointment by weekday", () => {
    expect(textOf(weeklySummary([call(0)], [appt(3, "Doctor")], TZ, NOW))).toContain("Doctor on Monday");
  });

  it("ignores appointments in the past or beyond the week", () => {
    const s = weeklySummary([call(0)], [appt(-2, "Old"), appt(30, "Far")], TZ, NOW);
    expect(textOf(s).some((t) => t.includes("Old") || t.includes("Far"))).toBe(false);
  });

  it("drops the disclaimer when no call connected this week", () => {
    // Found by loading the real dashboard as a brand-new household: with no calls but an
    // appointment coming up, the panel rendered one line and then "This is a record of what
    // was said on the calls" — about a week in which nothing was said.
    const s = weeklySummary([], [appt(3, "Doctor")], TZ, NOW);
    expect(s.lines.map((l) => l.text)).toEqual(["Doctor on Monday"]);
    expect(s.disclaimer).toBeNull();
  });

  it("keeps the disclaimer as soon as a call has connected", () => {
    expect(weeklySummary([call(1, { concerns: ["x"] })], [], TZ, NOW).disclaimer).toBe(WEEKLY_DISCLAIMER);
  });

  it("is empty when there is nothing to say yet", () => {
    const s = weeklySummary([], [], TZ, NOW);
    expect(s.empty).toBe(true);
    expect(s.lines).toEqual([]);
  });
});
