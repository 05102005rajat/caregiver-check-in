import { describe, expect, it } from "vitest";
import { allClearMessage, unaccountedMedications } from "./allclear";

const at = new Date("2026-09-24T15:10:00Z"); // 08:10 in Los Angeles
const base = { parentName: "Nora", at, timezone: "America/Los_Angeles" };

describe("allClearMessage", () => {
  it("is one line, and names what was actually confirmed", () => {
    const msg = allClearMessage({ ...base, medsConfirmed: ["Aspirin"] });
    expect(msg).toBe("✓ Nora's 8:10am check-in — Aspirin taken. All good.");
    expect(msg.split("\n").length).toBe(1);
  });

  it("names every medication rather than counting them", () => {
    // "2 medications taken" is a number the reader has to decode. The names are shorter
    // than the sentence around them.
    const msg = allClearMessage({ ...base, medsConfirmed: ["Aspirin", "Metformin"] });
    expect(msg).toContain("Aspirin, Metformin taken");
  });

  it("says nothing about medication when none was due", () => {
    // A call at an hour with no dose is ordinary. Explaining it every day is noise.
    const msg = allClearMessage({ ...base, medsConfirmed: [] });
    expect(msg).toBe("✓ Nora's 8:10am check-in — All good.");
    expect(msg).not.toMatch(/medication|none|no doses/i);
  });

  it("uses the parent's local time, not the server's", () => {
    // The same instant, on the other side of the world. A caregiver reading "8:10am" needs
    // it to be 8:10am where their parent is.
    const msg = allClearMessage({ ...base, timezone: "Asia/Kolkata", medsConfirmed: [] });
    expect(msg).toContain("8:40pm");
  });

  it("is visually unmistakable from an attention alert", () => {
    // The whole design: a reader tells these apart in a notification shade at a glance.
    // Same shape every day, leading tick, one line — against a header and bullets.
    const clear = allClearMessage({ ...base, medsConfirmed: ["Aspirin"] });
    expect(clear.startsWith("✓")).toBe(true);
    expect(clear).not.toContain("needs a look");
    expect(clear).not.toContain("•");
  });

  it("claims only what the call established", () => {
    // It reports what was CONFIRMED, never that nothing is wrong with them. A check-in where
    // nobody mentioned a problem is not evidence there is no problem, and a daily line that
    // overclaims is how a family stops believing the one that eventually matters.
    const msg = allClearMessage({ ...base, medsConfirmed: ["Aspirin"] });
    for (const overclaim of ["everything is fine", "nothing is wrong", "healthy", "well"]) {
      expect(msg.toLowerCase()).not.toContain(overclaim);
    }
  });
});

describe("unaccountedMedications", () => {
  it("accounts for a dose the model spelled differently", () => {
    // The reason exact equality was wrong: medsConfirmed holds the model's string.
    expect(unaccountedMedications(["Metformin"], ["metformin 500mg"])).toEqual([]);
  });

  it("does not let one confirmed dose account for a second, similarly named one", () => {
    // The reason fuzzy-many-to-many was worse. Only the D3 was confirmed; the plain
    // Vitamin D was never mentioned and must not be rounded up into "All good".
    expect(unaccountedMedications(["Vitamin D", "Vitamin D3"], ["vitamin d3"])).toEqual(["vitamin d"]);
    expect(unaccountedMedications(["Metformin", "Metformin ER"], ["metformin er"])).toEqual(["metformin"]);
  });

  it("is satisfied when both are actually confirmed", () => {
    expect(unaccountedMedications(["Vitamin D", "Vitamin D3"], ["vitamin d", "vitamin d3"])).toEqual([]);
  });

  it("reports a dose nobody mentioned at all", () => {
    expect(unaccountedMedications(["Aspirin"], [])).toEqual(["aspirin"]);
  });

  it("counts a dose that was missed as accounted for — we know the answer", () => {
    // The caller passes confirmed AND missed. "Not taken" is an answer; it routes to the
    // concern path, not to silence.
    expect(unaccountedMedications(["Aspirin"], ["Aspirin"])).toEqual([]);
  });

  it("says nothing is outstanding when no dose was due", () => {
    expect(unaccountedMedications([], ["something the model invented"])).toEqual([]);
  });

  it("does not match on a fragment shorter than the threshold", () => {
    // A three-letter name must not match everything, the same guard isKnownMed carries.
    expect(unaccountedMedications(["Zinc"], ["zin"])).toEqual(["zinc"]);
  });
});
