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

  it("does not let two spellings of one drug cover a second, separate dose", () => {
    // The one-to-one guard alone did not close this. The model returned the D3 twice
    // ("vitamin d3", "vitamin d3 1000 iu"); the first claimed the D3 entry and the second
    // CASCADED onto the plain Vitamin D, which the call never mentioned — reporting nothing
    // outstanding and texting the family "All good." about a dose nobody spoke about.
    expect(unaccountedMedications(["Vitamin D", "Vitamin D3"], ["vitamin d3", "vitamin d3 1000 iu"])).toEqual([
      "vitamin d",
    ]);
  });

  it("names the dose that is actually outstanding, not a similar one", () => {
    // Same cascade, visible from the other side. "metformin er 500mg" is unambiguously the
    // ER entry, but a first-match walk gave it to plain "Metformin" — so the caregiver was
    // warned about the one drug that WAS confirmed and told nothing about the one that
    // wasn't. A warning naming the wrong drug is worse than no warning: it is checkable,
    // and it checks out wrong.
    expect(unaccountedMedications(["Metformin", "Metformin ER"], ["metformin er 500mg"])).toEqual(["metformin"]);
  });

  it("gives a short answer the generic dose, not the most specific one", () => {
    // Ranking by raw length is only right when the answer is MORE specific than the dose
    // name. Here it is less: "vitamin d" fits "Vitamin D3" far better than the 18-character
    // "Vitamin D3 1000 IU" it was being handed, which was already claimed — so the answer was
    // spent and a dose the call did mention got reported outstanding, silencing the all-clear.
    expect(
      unaccountedMedications(["Vitamin D3 1000 IU", "Vitamin D3"], ["vitamin d3 1000 iu", "vitamin d"]),
    ).toEqual([]);
  });

  it("accounts for both rows when one drug is scheduled twice in the same slot", () => {
    // 500mg and 1000mg at the same hour is a real regimen, and nothing rejects two rows with
    // the same name. Both entries are an identical, exact fit for either answer — so the
    // no-cascade rule alone sent the second confirmation to the first entry again, spent it,
    // and left row two unaccounted. That household logs a warning and takes the SILENT branch
    // after every clean call: no daily line, ever, indistinguishable from a dead scheduler.
    expect(unaccountedMedications(["Metformin", "Metformin"], ["metformin", "metformin"])).toEqual([]);
    expect(unaccountedMedications(["Metformin", "Metformin"], ["metformin 500mg", "metformin 1000mg"])).toEqual([]);
  });

  it("still reports the second row when only one of two identical doses was confirmed", () => {
    // The control for the case above. Preferring a free entry must not become "one answer
    // covers both" — that is the unsafe direction, and it is one line away from it.
    expect(unaccountedMedications(["Metformin", "Metformin"], ["metformin"])).toEqual(["metformin"]);
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
