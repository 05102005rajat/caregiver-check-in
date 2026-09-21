import { describe, expect, it } from "vitest";
import { hasParentResponse, reachedVoicemail, rosieAbortedForMissingDetails, scanForConcernKeywords } from "./safety";

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
    // Shape of a production call where the parent answered and immediately hung up. Name
    // replaced: this repo is public and the one live household is a real person.
    expect(hasParentResponse("AI: Hi Nora, it's Rosie calling for your check-in. How are you feeling today?\n")).toBe(false);
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

describe("rosieAbortedForMissingDetails", () => {
  // Verbatim from the production call that caused this. Rosie spoke her upstream-failure
  // line even though parent_name was sent correctly, and the family was then texted that
  // their mother "seemed confused or disconnected".
  const REAL = [
    "AI: Hi Manju, it's Rosie calling for your check-in. How are you feeling today?",
    "User: Sure.",
    "AI: I'm sorry. Something has gone wrong on my end, and I don't have your details. I won't keep you. Goodbye.",
    "User: I mean, the.",
    "AI: I'm sorry.",
    "User: Like, we did for 57 and 558, right? Yeah.",
  ].join("\n");

  it("detects the abort in the real production transcript", () => {
    expect(rosieAbortedForMissingDetails(REAL)).toBe(true);
  });

  it("is false for an ordinary check-in (control)", () => {
    const ok = [
      "AI: Hi Nora, it's Rosie calling for your check-in. How are you feeling today?",
      "User: Good thanks, took my Metformin already.",
      "AI: Lovely. Take care, Nora.",
    ].join("\n");
    expect(rosieAbortedForMissingDetails(ok)).toBe(false);
  });

  it("ignores the words when the PERSON says them, not Rosie", () => {
    // A real conversation about the phrase is still a real conversation. Only her own turn
    // means the call was aborted.
    const quoted = [
      "AI: Hi Nora, it's Rosie calling for your check-in.",
      "User: Last time you said you don't have your details, what happened there?",
      "AI: I'm sorry about that. How are you feeling today?",
    ].join("\n");
    expect(rosieAbortedForMissingDetails(quoted)).toBe(false);
  });

  it("matches the apostrophe-free and reworded-apology forms", () => {
    expect(rosieAbortedForMissingDetails("AI: Sorry, I dont have your details.")).toBe(true);
    expect(rosieAbortedForMissingDetails("AI: My records are empty — I do not have your details today.")).toBe(true);
  });

  it("does not fire on an empty or content-free transcript", () => {
    expect(rosieAbortedForMissingDetails("")).toBe(false);
    expect(rosieAbortedForMissingDetails("AI: Hello?")).toBe(false);
  });
});

describe("reachedVoicemail", () => {
  it("detects the real production greeting Vapi did not flag", () => {
    // This one reached the family as "Not taken: Lisinopril, Metformin".
    const real = [
      "AI: Hi Manju, it's Rosie calling for your check-in. How are you feeling today?",
      "User: Please record your message. When you have finished recording, you may hang up.",
      "AI: Goodby",
    ].join("\n");
    expect(reachedVoicemail(real)).toBe(true);
  });

  it("detects the common greeting shapes", () => {
    expect(reachedVoicemail("User: Please leave your message after the beep.")).toBe(true);
    expect(reachedVoicemail("User: You have reached the voicemail of Nora.")).toBe(true);
    expect(reachedVoicemail("User: Nora is not available right now.")).toBe(true);
  });

  it("is false for a real conversation (control)", () => {
    const ok = ["AI: Hi Nora, how are you today?", "User: I'm alright, took my tablets."].join("\n");
    expect(reachedVoicemail(ok)).toBe(false);
  });

  it("does not fire when a PERSON talks about leaving a message", () => {
    // The reason "leave a message" alone is not in the pattern: people say it about others.
    expect(reachedVoicemail("User: Could you leave a message for my daughter?")).toBe(false);
  });

  it("does not fire on Rosie's own words", () => {
    expect(reachedVoicemail("AI: Shall I leave your message after the beep?")).toBe(false);
  });
});
