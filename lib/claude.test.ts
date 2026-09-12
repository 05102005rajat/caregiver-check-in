import { describe, expect, it } from "vitest";
import { extractJson, normalize } from "./claude";

describe("normalize", () => {
  it("passes through a well-formed response unchanged", () => {
    const result = normalize({
      summary: "All good.",
      meds_confirmed: ["Lisinopril"],
      meds_missed: [],
      concerns: [],
      mood: "good",
      appointments_acknowledged: ["Dentist"],
    });
    expect(result).toEqual({
      summary: "All good.",
      meds_confirmed: ["Lisinopril"],
      meds_missed: [],
      concerns: [],
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
      concerns: [],
      mood: "okay",
      appointments_acknowledged: [],
    });
  });

  it("defaults everything when given a non-object (e.g. Claude returned an array or null)", () => {
    expect(normalize(null)).toEqual({
      summary: "",
      meds_confirmed: [],
      meds_missed: [],
      concerns: [],
      mood: "okay",
      appointments_acknowledged: [],
    });
    expect(normalize([1, 2, 3])).toEqual({
      summary: "",
      meds_confirmed: [],
      meds_missed: [],
      concerns: [],
      mood: "okay",
      appointments_acknowledged: [],
    });
  });

  it("filters non-string entries out of array fields instead of crashing", () => {
    const result = normalize({ meds_missed: ["Aspirin", 42, null, "Metformin"] });
    expect(result.meds_missed).toEqual(["Aspirin", "Metformin"]);
  });

  it("rejects an invalid mood value rather than propagating it", () => {
    const result = normalize({ mood: "extremely-worried" });
    expect(result.mood).toBe("okay");
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
