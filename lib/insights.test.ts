import { describe, expect, it } from "vitest";
import { describeChanges, needsAttention } from "./insights";
import type { Call } from "@/types/db";

function call(overrides: Partial<Call> = {}): Call {
  return {
    id: "c1",
    parent_id: "p1",
    scheduled_for: "2026-09-10T16:00:00Z",
    called_at: "2026-09-10T16:00:05Z",
    status: "completed",
    vapi_call_id: "v1",
    retry_count: 0,
    transcript: "…",
    summary: "…",
    meds_confirmed: { confirmed: [], missed: [], appointments_acknowledged: [] },
    concerns: [],
    scheduled_meds: [],
    mood: "good",
    created_at: "2026-09-10T16:00:00Z",
    ...overrides,
  };
}

describe("describeChanges", () => {
  it("reports nothing for a clean call — silence is the point of the product", () => {
    expect(describeChanges(call(), [call(), call()])).toEqual([]);
  });

  it("flags a concern that hasn't come up before as new", () => {
    const latest = call({ concerns: ["dizziness"] });
    const changes = describeChanges(latest, [call(), call()]);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("new_concern");
    expect(changes[0].detail).toBe("dizziness");
  });

  it("distinguishes a recurring concern from a brand-new one", () => {
    const latest = call({ concerns: ["knee pain"] });
    const changes = describeChanges(latest, [call({ concerns: ["knee pain"] })]);
    expect(changes[0].kind).toBe("repeat_concern");
  });

  it("calls out a medication they'd normally been taking", () => {
    const latest = call({ meds_confirmed: { confirmed: [], missed: ["Lisinopril"] } });
    const previous = [call({ meds_confirmed: { confirmed: ["Lisinopril"], missed: [] } })];
    const changes = describeChanges(latest, previous);
    expect(changes[0].kind).toBe("missed_medication");
    expect(changes[0].detail).toContain("normally taken");
  });

  it("still reports a missed medication with no prior history, just less emphatically", () => {
    const latest = call({ meds_confirmed: { confirmed: [], missed: ["Lisinopril"] } });
    const changes = describeChanges(latest, []);
    expect(changes[0].kind).toBe("missed_medication");
    expect(changes[0].detail).not.toContain("normally taken");
  });

  it("flags a mood decline against a better baseline", () => {
    const latest = call({ mood: "low" });
    const changes = describeChanges(latest, [call({ mood: "good" }), call({ mood: "okay" })]);
    expect(changes.some((c) => c.kind === "mood_decline")).toBe(true);
  });

  it("does NOT flag mood when they already sounded low recently (no daily repeat alert)", () => {
    const latest = call({ mood: "low" });
    const changes = describeChanges(latest, [call({ mood: "low" }), call({ mood: "good" })]);
    expect(changes.some((c) => c.kind === "mood_decline")).toBe(false);
  });

  it("does not invent a mood decline with no baseline to compare against", () => {
    expect(describeChanges(call({ mood: "low" }), [])).toEqual([]);
  });

  it("is case-insensitive when matching concerns and medications against history", () => {
    const latest = call({ concerns: ["Knee Pain"], meds_confirmed: { confirmed: [], missed: ["LISINOPRIL"] } });
    const previous = [call({ concerns: ["knee pain"], meds_confirmed: { confirmed: ["lisinopril"], missed: [] } })];
    const changes = describeChanges(latest, previous);
    expect(changes.find((c) => c.kind === "repeat_concern")).toBeDefined();
    expect(changes.find((c) => c.kind === "missed_medication")?.detail).toContain("normally taken");
  });

  it("handles missing/null fields without throwing", () => {
    const latest = call({ concerns: null, meds_confirmed: null, mood: null });
    expect(() => describeChanges(latest, [call({ concerns: null, meds_confirmed: null })])).not.toThrow();
    expect(describeChanges(latest, [])).toEqual([]);
  });
});

describe("needsAttention", () => {
  it("is false for a clean completed call", () => {
    expect(needsAttention(call())).toBe(false);
  });

  it("is true when a medication went unconfirmed", () => {
    expect(needsAttention(call({ meds_confirmed: { confirmed: [], missed: ["Lisinopril"] } }))).toBe(true);
  });

  it("is true when there are concerns", () => {
    expect(needsAttention(call({ concerns: ["fell"] }))).toBe(true);
  });

  it("is true for a call that never connected", () => {
    expect(needsAttention(call({ status: "no_answer" }))).toBe(true);
    expect(needsAttention(call({ status: "failed" }))).toBe(true);
  });
});
