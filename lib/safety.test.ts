import { describe, expect, it } from "vitest";
import { scanForConcernKeywords, hasParentResponse } from "./safety";

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

describe("hasParentResponse", () => {
  it("is false for the real transcript of a call the parent hung up on", () => {
    // Verbatim shape of a production call where the parent answered and immediately hung up.
    expect(hasParentResponse("AI: Hi Manju, it's Rosie calling for your check-in. How are you feeling today?\n")).toBe(false);
  });

  it("is true as soon as the parent says anything, even one word", () => {
    expect(hasParentResponse("AI: How are you?\nUser: Fine.\n")).toBe(true);
  });

  it("tolerates alternative speaker labels rather than assuming one transcript format", () => {
    expect(hasParentResponse("AI: Hello?\nCustomer: yes hello")).toBe(true);
    expect(hasParentResponse("Assistant: Hello?\nHuman: hi")).toBe(true);
  });

  it("is false for an empty or whitespace transcript", () => {
    expect(hasParentResponse("")).toBe(false);
    expect(hasParentResponse("   \n  ")).toBe(false);
  });

  it("does not count the assistant merely saying the word 'user'", () => {
    expect(hasParentResponse("AI: I'll let the user know about that.\n")).toBe(false);
  });
});

describe("scanForConcernKeywords — parent turns only", () => {
  it("does not trip on the assistant's own words", () => {
    // Rosie echoes watch-item text every call, so scanning her turns made the backstop
    // fire daily for any watch item containing a keyword.
    const transcript = "AI: How's the knee pain today, and did you have another fall?\nUser: All fine thanks.\n";
    expect(scanForConcernKeywords(transcript, ["pain", "fall"])).toEqual([]);
  });

  it("still catches what the parent actually says", () => {
    const transcript = "AI: How are you?\nUser: I had a fall this morning.\n";
    expect(scanForConcernKeywords(transcript, ["fall"])).toEqual(["fall"]);
  });

  it("falls back to scanning everything when speaker labels are unrecognizable", () => {
    // Over-reporting beats missing a real emergency if Vapi ever changes transcript shape.
    expect(scanForConcernKeywords("she mentioned chest pain", ["chest"])).toEqual(["chest"]);
  });
});
