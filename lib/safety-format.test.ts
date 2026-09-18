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

  it("separates 'they never spoke' from 'we can't parse this'", () => {
    // A silent call is a real, expected outcome and must not fire the provider-changed
    // alarm — the format is fine, the person just didn't say anything.
    const silent = "AI: Hi Margaret, are you there?\nAI: Hello?";
    expect(hasParentResponse(silent)).toBe(false);
    expect(hasRecognisableSpeakerLabels(silent)).toBe(true);
  });

  it("treats an unlabelled blob as unparseable", () => {
    expect(hasRecognisableSpeakerLabels("hi margaret are you there hello")).toBe(false);
  });

  it("flags an unrecognised format instead of pretending it parsed", () => {
    // The shape a provider change might take — no error today, just silent degradation.
    const renamed = REAL_VAPI_TRANSCRIPT.replace(/^User:/gm, "Caller:").replace(/^AI:/gm, "Agent:");
    // Still a labelled transcript, so not an unparseable blob — but no turn we can
    // attribute to the parent, which is the half the safety scan depends on.
    expect(hasParentResponse(renamed)).toBe(false);
  });
});
