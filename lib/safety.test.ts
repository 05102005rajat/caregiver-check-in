import { describe, expect, it } from "vitest";
import { scanForConcernKeywords } from "./safety";

const KEYWORDS = ["fall", "fell", "dizzy", "pain", "chest", "breath", "confused", "scared"];

describe("scanForConcernKeywords", () => {
  it("matches a whole-word keyword", () => {
    expect(scanForConcernKeywords("I fell down yesterday", KEYWORDS)).toEqual(["fell"]);
  });

  it("does not false-positive on a substring of a keyword", () => {
    expect(scanForConcernKeywords("I went painting today", ["pain"])).toEqual([]);
  });

  it("matches multiple distinct keywords in one transcript", () => {
    const result = scanForConcernKeywords("my chest hurts and I feel a lot of pain", ["chest", "pain"]);
    expect(result.sort()).toEqual(["chest", "pain"]);
  });

  it("is case-insensitive", () => {
    expect(scanForConcernKeywords("I am DIZZY today", ["dizzy"])).toEqual(["dizzy"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(scanForConcernKeywords("I had a lovely lunch and a nap", KEYWORDS)).toEqual([]);
  });
});
