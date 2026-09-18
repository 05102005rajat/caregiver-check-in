import { describe, expect, it } from "vitest";
import { DEFAULT_CONCERN_KEYWORDS, hasParentResponse, hasRecognisableSpeakerLabels, scanForConcernKeywords } from "./safety";
import { REAL_VAPI_TRANSCRIPT } from "./__fixtures__/vapi-transcript";

describe("the speaker-label format the safety backstop depends on", () => {
  it("is what Vapi actually produces (real captured transcript)", () => {
    // If this fails, Vapi changed the transcript format and BOTH backstops are degraded —
    // see the fixture's comment. It is the only test here backed by production output.
    expect(hasRecognisableSpeakerLabels(REAL_VAPI_TRANSCRIPT)).toBe(true);
    expect(hasParentResponse(REAL_VAPI_TRANSCRIPT)).toBe(true);
  });

  it("scans only the parent's turns on a real transcript, not Rosie's", () => {
    // Rosie says "call 911" in this real transcript. Scanning her words would alert the
    // family every time she reads the emergency script — which is every call.
    expect(REAL_VAPI_TRANSCRIPT).toContain("call 911");
    const fromAssistantOnly = REAL_VAPI_TRANSCRIPT.split("\n")
      .filter((l) => l.startsWith("AI:"))
      .join("\n");
    expect(scanForConcernKeywords(fromAssistantOnly, DEFAULT_CONCERN_KEYWORDS)).toEqual([]);
  });

  it("recognises a transcript with no parent turns as exactly that", () => {
    expect(hasParentResponse("AI: Hi Margaret, are you there?\nAI: Hello?")).toBe(false);
    expect(hasRecognisableSpeakerLabels("AI: Hi Margaret, are you there?")).toBe(false);
  });

  it("flags an unrecognised format instead of pretending it parsed", () => {
    // The shape a provider change might take — no error today, just silent degradation.
    const renamed = REAL_VAPI_TRANSCRIPT.replace(/^User:/gm, "Caller:").replace(/^AI:/gm, "Agent:");
    expect(hasRecognisableSpeakerLabels(renamed)).toBe(false);
  });
});
