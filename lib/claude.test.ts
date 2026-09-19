import { describe, expect, it } from "vitest";
import { extractJson, normalize } from "./claude";

describe("normalize", () => {
  it("passes through a well-formed response unchanged", () => {
    const result = normalize({
      summary: "All good.",
      meds_confirmed: ["Lisinopril"],
      meds_missed: [],
      meds_missed_reasons: {},
      concerns: [],
      requests: [],
      mood: "good",
      appointments_acknowledged: ["Dentist"],
    });
    expect(result).toEqual({
      summary: "All good.",
      meds_confirmed: ["Lisinopril"],
      meds_missed: [],
      meds_missed_reasons: {},
      concerns: [],
      requests: [],
      mood: "good",
      appointments_acknowledged: ["Dentist"],
    });
  });

  it("defaults every field when Claude returns a truncated/malformed object (simulated Claude failure)", () => {
    const result = normalize({ summary: "Partial only" });
    expect(result).toEqual({
      summary: "Partial only",
      meds_confirmed: [],
      meds_missed: [],
      meds_missed_reasons: {},
      concerns: [],
      requests: [],
      mood: "unknown",
      appointments_acknowledged: [],
    });
  });

  it("defaults everything when given a non-object (e.g. Claude returned an array or null)", () => {
    expect(normalize(null)).toEqual({
      summary: "",
      meds_confirmed: [],
      meds_missed: [],
      meds_missed_reasons: {},
      concerns: [],
      requests: [],
      mood: "unknown",
      appointments_acknowledged: [],
    });
    expect(normalize([1, 2, 3])).toEqual({
      summary: "",
      meds_confirmed: [],
      meds_missed: [],
      meds_missed_reasons: {},
      concerns: [],
      requests: [],
      mood: "unknown",
      appointments_acknowledged: [],
    });
  });

  it("filters non-string entries out of array fields instead of crashing", () => {
    const result = normalize({ meds_missed: ["Aspirin", 42, null, "Metformin"] });
    expect(result.meds_missed).toEqual(["Aspirin", "Metformin"]);
  });

  it("treats an invalid mood value as unknown (not a fabricated 'okay') rather than propagating it", () => {
    const result = normalize({ mood: "extremely-worried" });
    expect(result.mood).toBe("unknown");
  });

  it("never throws regardless of input shape", () => {
    for (const bad of [undefined, "a string", 123, true, {}, { mood: 5 }]) {
      expect(() => normalize(bad)).not.toThrow();
    }
  });

  it("clamps an unexpectedly long summary and array items instead of storing/texting it unbounded", () => {
    const result = normalize({
      summary: "x".repeat(5000),
      meds_confirmed: ["y".repeat(500)],
    });
    expect(result.summary.length).toBe(1000);
    expect(result.meds_confirmed[0].length).toBe(200);
  });

  it("caps the number of array items instead of accepting an unbounded list", () => {
    const result = normalize({ concerns: Array.from({ length: 50 }, (_, i) => `concern ${i}`) });
    expect(result.concerns).toHaveLength(20);
  });
});

describe("extractJson", () => {
  it("parses a pure JSON response directly", () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("extracts a JSON object embedded in extra text", () => {
    expect(extractJson('Here is the result: {"a":1} — hope that helps')).toBe('{"a":1}');
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("meds_missed_reasons", () => {
  it("carries why a dose wasn't taken", () => {
    // "Not taken: metformin" and "couldn't tell which pill it was" were two separate
    // bullets in the text, and joining cause to effect was left to a worried reader. The
    // reason is the part that decides what they do: label the pill box, or have a
    // conversation.
    const r = normalize({ meds_missed: ["Metformin"], meds_missed_reasons: { Metformin: "couldn't tell which pill it was" } });
    expect(r.meds_missed_reasons).toEqual({ Metformin: "couldn't tell which pill it was" });
  });

  it("drops anything that isn't a string pair", () => {
    const r = normalize({ meds_missed_reasons: { Good: "ran out", Bad: 42, Empty: "   ", "": "x" } });
    expect(r.meds_missed_reasons).toEqual({ Good: "ran out" });
  });

  it("defaults to an empty object for an array, a string, or null", () => {
    for (const bad of [["a"], "nope", null, 7]) {
      expect(normalize({ meds_missed_reasons: bad }).meds_missed_reasons).toEqual({});
    }
  });

  it("clamps a runaway reason rather than texting it to a family", () => {
    const r = normalize({ meds_missed_reasons: { Metformin: "x".repeat(5000) } });
    expect(Object.values(r.meds_missed_reasons)[0].length).toBeLessThan(500);
  });
});

describe("concerns are never dropped", () => {
  it("keeps a short concern even when a longer one reuses its words", () => {
    // A dedupe added here once removed "fell" because the words appear inside "Fell out
    // with her neighbour" — an argument, not a fall. It silently deleted a fall report from
    // the text sent to the family, which is the one direction this product must not fail.
    // Nothing in normalize may drop a concern the model returned.
    const r = normalize({ concerns: ["fell", "Fell out with her neighbour and is upset about it"] });
    expect(r.concerns).toEqual(["fell", "Fell out with her neighbour and is upset about it"]);
  });

  it("keeps an exact duplicate rather than deciding which one mattered", () => {
    expect(normalize({ concerns: ["dizzy", "dizzy"] }).concerns).toEqual(["dizzy", "dizzy"]);
  });
});
