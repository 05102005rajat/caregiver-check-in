import { describe, expect, it } from "vitest";
import { allClearMessage, unaccountedMedications, unconfirmedLine, unconfirmedMessage } from "./allclear";

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

describe("unconfirmedMessage", () => {
  it("says what was confirmed and names what could not be", () => {
    const msg = unconfirmedMessage({ ...base, medsConfirmed: ["Metformin ER"], unconfirmed: ["Metformin"], scheduled: ["Metformin", "Metformin ER"] });
    expect(msg).toBe("Nora's 8:10am check-in — Metformin ER taken. Couldn't confirm: Metformin. Worth asking.");
  });

  it("never looks like, or claims, an all-clear", () => {
    // The point of this text is that it is sent where "All good." would have been false.
    const msg = unconfirmedMessage({ ...base, medsConfirmed: ["Aspirin"], unconfirmed: ["Metformin"], scheduled: ["Aspirin", "Metformin"] });
    expect(msg.startsWith("✓")).toBe(false);
    expect(msg).not.toContain("All good");
    expect(msg.split("\n").length).toBe(1);
  });

  it("does not read as an alarm either", () => {
    // Usually our matching being unsure, not a skipped dose. Alarm-shaped routine texts
    // teach a family to stop reading the real ones.
    const msg = unconfirmedMessage({ ...base, medsConfirmed: [], unconfirmed: ["Metformin"], scheduled: ["Metformin"] });
    expect(msg).not.toContain("needs a look");
    expect(msg).not.toContain("URGENT");
    expect(msg).not.toContain("•");
  });

  it("names a drug scheduled twice at one hour once when neither dose was confirmed", () => {
    const msg = unconfirmedMessage({
      ...base,
      medsConfirmed: [],
      unconfirmed: ["Metformin", "Metformin"],
      scheduled: ["Metformin", "Metformin"],
    });
    expect(msg).toBe("Nora's 8:10am check-in — Couldn't confirm: Metformin. Worth asking.");
  });

  it("counts the dose when only one of two same-named rows was confirmed", () => {
    // Found by review: the extractor collapses "the 500 and the 1000" into one "Metformin",
    // and the plain wording read "Metformin taken. Couldn't confirm: Metformin." — a
    // contradiction the caregiver could not act on, every day.
    const msg = unconfirmedMessage({
      ...base,
      medsConfirmed: ["Metformin"],
      unconfirmed: ["Metformin"],
      scheduled: ["Metformin", "Metformin"],
    });
    expect(msg).toBe("Nora's 8:10am check-in — Metformin taken. Couldn't confirm: 1 of 2 Metformin doses. Worth asking.");
  });
});

describe("unconfirmedLine", () => {
  const input = { scheduled: ["Vitamin D"], unconfirmed: ["Vitamin D"], medsConfirmed: ["Vitamin D3"], suppress: false };

  it("names the dose and what WAS confirmed, so a naming mismatch is visible", () => {
    expect(unconfirmedLine(input)).toBe("Couldn't confirm: Vitamin D (confirmed: Vitamin D3)");
  });

  it("is omitted where talking about doses would mislead", () => {
    // No answer, an unreadable call, or an URGENT text. The caller decides which; this pins
    // that the flag is honoured, because the review found the line displacing the
    // "we couldn't make out what was said" explanation and sitting under an URGENT header.
    expect(unconfirmedLine({ ...input, suppress: true })).toBeNull();
  });

  it("is omitted when every dose was accounted for", () => {
    expect(unconfirmedLine({ ...input, unconfirmed: [] })).toBeNull();
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
    expect(unaccountedMedications(["Vitamin D", "Vitamin D3"], ["vitamin d3"])).toEqual(["Vitamin D"]);
    expect(unaccountedMedications(["Metformin", "Metformin ER"], ["metformin er"])).toEqual(["Metformin"]);
  });

  it("does not let two spellings of one drug cover a second, separate dose", () => {
    // The one-to-one guard alone did not close this. The model returned the D3 twice
    // ("vitamin d3", "vitamin d3 1000 iu"); the first claimed the D3 entry and the second
    // CASCADED onto the plain Vitamin D, which the call never mentioned — reporting nothing
    // outstanding and texting the family "All good." about a dose nobody spoke about.
    expect(unaccountedMedications(["Vitamin D", "Vitamin D3"], ["vitamin d3", "vitamin d3 1000 iu"])).toEqual([
      "Vitamin D",
    ]);
  });

  it("names the dose that is actually outstanding, not a similar one", () => {
    // Same cascade, visible from the other side. "metformin er 500mg" is unambiguously the
    // ER entry, but a first-match walk gave it to plain "Metformin" — so the caregiver was
    // warned about the one drug that WAS confirmed and told nothing about the one that
    // wasn't. A warning naming the wrong drug is worse than no warning: it is checkable,
    // and it checks out wrong.
    expect(unaccountedMedications(["Metformin", "Metformin ER"], ["metformin er 500mg"])).toEqual(["Metformin"]);
  });

  it("gives a short answer the generic dose, not the most specific one", () => {
    // "vitamin d" abbreviates Vitamin D3 and leaves nothing of it uncovered; against
    // "Vitamin D3 1000 IU" it leaves two words uncovered. The closer name wins, and the
    // exact answer has already taken the 1000 IU entry anyway.
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
    expect(unaccountedMedications(["Metformin", "Metformin"], ["Metformin"])).toEqual(["Metformin"]);
  });

  it("does not let a second spelling of the D3 cover a plain Vitamin D nobody mentioned", () => {
    // Found by review against the length-based ranking: "vitamin d3" is one character from
    // "vitamin d" and eight from "vitamin d3 1000 iu", so once the exact answer took the D3
    // row, the variant spelling claimed the plain Vitamin D — and the family was told
    // "All good." about a dose the call never discussed. In either order.
    const scheduled = ["Vitamin D", "Vitamin D3 1000 IU"];
    expect(unaccountedMedications(scheduled, ["vitamin d3 1000 iu", "vitamin d3"])).toEqual(["Vitamin D"]);
    expect(unaccountedMedications(scheduled, ["vitamin d3", "vitamin d3 1000 iu"])).toEqual(["Vitamin D"]);
    // The same shape with a different drug, so the fix is the rule and not the vitamin.
    expect(unaccountedMedications(["Metformin", "Metformin ER 500mg"], ["metformin er 500mg", "metformin er"])).toEqual([
      "Metformin",
    ]);
  });

  it("accounts for both doses whatever order the model lists them in", () => {
    // The other half of the same review. With "vitamin d3" first, the length ranking handed
    // it the plain Vitamin D row; the exact "vitamin d" that followed found its own entry
    // taken, and a call that confirmed both doses went silent — naming the D3, which WAS
    // taken, as the outstanding one.
    const scheduled = ["Vitamin D", "Vitamin D3 1000 IU"];
    expect(unaccountedMedications(scheduled, ["vitamin d3", "vitamin d"])).toEqual([]);
    expect(unaccountedMedications(scheduled, ["vitamin d", "vitamin d3"])).toEqual([]);
  });

  it("accounts for nothing when an answer could be either of two different drugs", () => {
    // A bare "vitamin" with Vitamin D and Vitamin B12 scheduled could be either. Guessing is
    // how a family hears about a dose that was not discussed, so both stay unconfirmed.
    expect(unaccountedMedications(["Vitamin D", "Vitamin B12"], ["vitamin"])).toEqual(["Vitamin D", "Vitamin B12"]);
    // Control: with only one of them scheduled there is nothing to confuse it with.
    expect(unaccountedMedications(["Vitamin D"], ["vitamin"])).toEqual([]);
  });

  it("treats a strength as detail, not as a different drug", () => {
    // The model reports the pill it heard about ("metformin 500 mg"), not the row's name.
    // Treating that as a contradiction would make one household's check-in say "couldn't
    // confirm" every day.
    expect(unaccountedMedications(["Metformin ER"], ["metformin 500 mg"])).toEqual([]);
    // But a changed WORD is still a different drug.
    expect(unaccountedMedications(["Vitamin D"], ["vitamin d3"])).toEqual(["Vitamin D"]);
  });

  it("treats a plural as the same drug", () => {
    // Found by review: the word matcher needed an exact word, so "fish oils" was a different
    // drug from Fish oil and that household got "couldn't confirm" after every call.
    expect(unaccountedMedications(["Fish oil"], ["fish oils"])).toEqual([]);
    expect(unaccountedMedications(["Eye drops"], ["eye drop"])).toEqual([]);
    // Control: a plural does not blur a changed word.
    expect(unaccountedMedications(["Vitamin D"], ["vitamin d3s"])).toEqual(["Vitamin D"]);
  });

  it("returns the scheduled spelling, because the caregiver reads it", () => {
    expect(unaccountedMedications(["Metformin ER", "Aspirin"], ["aspirin"])).toEqual(["Metformin ER"]);
  });

  it("is satisfied when both are actually confirmed", () => {
    expect(unaccountedMedications(["Vitamin D", "Vitamin D3"], ["vitamin d", "vitamin d3"])).toEqual([]);
  });

  it("reports a dose nobody mentioned at all", () => {
    expect(unaccountedMedications(["Aspirin"], [])).toEqual(["Aspirin"]);
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
    expect(unaccountedMedications(["Zinc"], ["zin"])).toEqual(["Zinc"]);
  });
});
