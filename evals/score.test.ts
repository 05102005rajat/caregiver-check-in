import { describe, expect, it } from "vitest";
import { buildReport, scoreCase } from "./score";
import type { EvalCase } from "./cases";
import type { CallSummary } from "@/lib/claude";

function output(overrides: Partial<CallSummary> = {}): CallSummary {
  return {
    summary: "…",
    meds_confirmed: [],
    meds_missed: [],
    meds_missed_reasons: {},
    concerns: [],
    requests: [],
    mood: "good",
    appointments_acknowledged: [],
    ...overrides,
  };
}

function testCase(expectOverrides: Partial<EvalCase["expect"]>): EvalCase {
  return {
    id: "t",
    rationale: "",
    transcript: "",
    expect: { anyConcern: false, ...expectOverrides },
  };
}

describe("scoreCase", () => {
  it("passes a clean expectation", () => {
    expect(scoreCase(testCase({}), output()).passed).toBe(true);
  });

  it("fails when a concern that mattered was missed", () => {
    const result = scoreCase(testCase({ anyConcern: true }), output({ concerns: [] }));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("would NOT have been alerted");
  });

  it("counts a missed medication as an alert, matching what production actually does", () => {
    // Production escalates on meds_missed even when `concerns` is empty, so scoring the
    // concerns array alone would fail behaviour that is correct end to end.
    const result = scoreCase(testCase({ anyConcern: true }), output({ concerns: [], meds_missed: ["Lisinopril"] }));
    expect(result.passed).toBe(true);
  });

  it("fails on a false alarm", () => {
    const result = scoreCase(testCase({ anyConcern: false }), output({ concerns: ["dizziness"] }));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("false alarm");
  });

  it("accepts a concern phrased differently as long as it's the right one", () => {
    const result = scoreCase(
      testCase({ anyConcern: true, concernMatches: ["dizz"] }),
      output({ concerns: ["reported dizziness on standing"] })
    );
    expect(result.passed).toBe(true);
  });

  it("fails when it raises a concern but about the wrong thing", () => {
    const result = scoreCase(
      testCase({ anyConcern: true, concernMatches: ["chest"] }),
      output({ concerns: ["seemed a bit tired"] })
    );
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("not the right one");
  });

  it("matches medications loosely so casing and dosage suffixes don't fail a correct answer", () => {
    const result = scoreCase(testCase({ medsConfirmed: ["Lisinopril"] }), output({ meds_confirmed: ["lisinopril 10mg"] }));
    expect(result.passed).toBe(true);
  });

  it("catches hallucinated medications when none were expected", () => {
    const result = scoreCase(testCase({ medsConfirmed: [] }), output({ meds_confirmed: ["Metformin"] }));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("hallucinated");
  });

  it("flags a mood outside the accepted range", () => {
    const result = scoreCase(testCase({ mood: ["good", "okay"] }), output({ mood: "concerning" }));
    expect(result.passed).toBe(false);
  });
});

describe("buildReport", () => {
  it("separates recall from false alarms, since they fail in opposite directions", () => {
    const cases = [
      testCase({ anyConcern: true }), // should catch — will miss
      testCase({ anyConcern: true }), // should catch — will catch
      testCase({ anyConcern: false }), // should stay quiet — will false alarm
    ];
    const outputs = [output({ concerns: [] }), output({ concerns: ["fell"] }), output({ concerns: ["noise"] })];

    const report = buildReport(cases, outputs);
    expect(report.concernRecall).toBeCloseTo(0.5);
    expect(report.falseAlarmRate).toBeCloseTo(1);
    expect(report.passed).toBe(1);
  });

  it("reports perfect scores when everything matches", () => {
    const cases = [testCase({ anyConcern: true }), testCase({ anyConcern: false })];
    const outputs = [output({ concerns: ["fell"] }), output()];
    const report = buildReport(cases, outputs);
    expect(report.concernRecall).toBe(1);
    expect(report.falseAlarmRate).toBe(0);
    expect(report.passed).toBe(2);
  });
});
