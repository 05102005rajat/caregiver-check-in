import { describe, expect, it } from "vitest";
import { SYSTEM_FAULT_CONCERN, SYSTEM_FAULT_SUMMARY, reportableFacts, type ExtractionFacts } from "./reportable";

/**
 * A model output where EVERY field carries something. That is the point: the abort case has
 * to empty all of them, and a fixture with blanks would pass no matter which ones leaked —
 * which is exactly how `mood`, then the keyword scan, the requests and the urgent flag each
 * survived a fix that claimed to have closed the class.
 */
const rich: ExtractionFacts = {
  summary: "She said her knee has been worse for two days and asked for a burger.",
  concerns: ["Knee pain worse than usual"],
  requests: ["Wants a burger"],
  medsConfirmed: ["Lisinopril"],
  medsMissed: ["Metformin"],
  missedReasons: { Metformin: "couldn't tell which pill it was" },
  appointmentsAcknowledged: ["Cardiology"],
  mood: "low",
  urgent: true,
};

const input = (over: Partial<Parameters<typeof reportableFacts>[0]> = {}) => ({
  extracted: rich,
  keywordMatches: ["pain"],
  noResponse: [],
  aborted: false,
  ...over,
});

describe("a normal call passes everything through", () => {
  it("keeps every field the model produced", () => {
    const r = reportableFacts(input());
    expect(r.aborted).toBe(false);
    expect(r.summary).toBe(rich.summary);
    expect(r.requests).toEqual(["Wants a burger"]);
    expect(r.medsConfirmed).toEqual(["Lisinopril"]);
    expect(r.medsMissed).toEqual(["Metformin"]);
    expect(r.missedReasons).toEqual({ Metformin: "couldn't tell which pill it was" });
    expect(r.appointmentsAcknowledged).toEqual(["Cardiology"]);
    expect(r.mood).toBe("low");
    expect(r.urgent).toBe(true);
    expect(r.keywordMatches).toEqual(["pain"]);
  });

  it("merges the keyword and no-response backstops into concerns, without duplicates", () => {
    const r = reportableFacts(input({ noResponse: ["Parent didn't respond"], keywordMatches: ["pain", "Knee pain worse than usual"] }));
    expect(r.concerns).toContain("Knee pain worse than usual");
    expect(r.concerns).toContain("pain");
    expect(r.concerns).toContain("Parent didn't respond");
    expect(r.concerns.filter((c) => c === "Knee pain worse than usual").length).toBe(1);
  });
});

describe("an aborted call reports our fault and nothing else", () => {
  const r = reportableFacts(input({ aborted: true }));

  it("replaces the summary, which is rendered under the parent's name", () => {
    expect(r.summary).toBe(SYSTEM_FAULT_SUMMARY);
    expect(r.summary).not.toContain("knee");
    expect(r.summary).not.toContain("burger");
  });

  it("replaces the concerns with the fault, naming it as ours", () => {
    expect(r.concerns).toEqual([SYSTEM_FAULT_CONCERN]);
  });

  it("drops the keyword scan — it read Rosie's apology, not the parent", () => {
    // The leak found in review: `flaggedWords` rendered "Also heard on the call: pain"
    // directly beneath a line saying the call did not happen.
    expect(r.keywordMatches).toEqual([]);
  });

  it("drops the requests — extracted from an apology, promised to nobody", () => {
    expect(r.requests).toEqual([]);
  });

  it("drops both medication lists and the reasons", () => {
    // She never asked. "Not taken" would be a verdict on a question nobody was given the
    // chance to answer, and the weekly summary counts stored misses across days.
    expect(r.medsMissed).toEqual([]);
    expect(r.medsConfirmed).toEqual([]);
    expect(r.missedReasons).toEqual({});
    expect(r.appointmentsAcknowledged).toEqual([]);
  });

  it("stores mood as unknown, not the model's read of a non-conversation", () => {
    expect(r.mood).toBe("unknown");
  });

  it("clears urgent — the most dangerous claim to fabricate", () => {
    expect(r.urgent).toBe(false);
  });

  it("leaves NOTHING the model inferred, checked field by field", () => {
    // The catch-all. Every previous fix in this family closed the fields someone thought of
    // and left one behind, so this asserts over the whole object rather than a list someone
    // has to remember to extend.
    const { aborted, summary, concerns, mood, ...inferred } = r;
    expect(aborted).toBe(true);
    expect(summary).toBe(SYSTEM_FAULT_SUMMARY);
    expect(concerns).toEqual([SYSTEM_FAULT_CONCERN]);
    expect(mood).toBe("unknown");
    for (const [field, value] of Object.entries(inferred)) {
      const empty = Array.isArray(value) ? value.length === 0 : typeof value === "object" ? Object.keys(value!).length === 0 : value === false;
      expect(empty, `${field} survived an aborted call carrying ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("still reports something — silence is the one outcome it must not produce", () => {
    // The opposite failure to guard against: dropping everything must not become dropping
    // the alert. A check-in that silently never happened is what this product exists to
    // prevent, so there is always a concern for the caller to act on.
    expect(r.concerns.length).toBeGreaterThan(0);
  });
});

describe("the two paths are genuinely different (control)", () => {
  it("the same input produces different output depending only on `aborted`", () => {
    // Without this, every assertion above is satisfied by a function that always returns the
    // fault — which would suppress real concerns about a real conversation.
    const normal = reportableFacts(input({ aborted: false }));
    const aborted = reportableFacts(input({ aborted: true }));
    expect(normal.concerns).not.toEqual(aborted.concerns);
    expect(normal.summary).not.toEqual(aborted.summary);
    expect(normal.medsMissed.length).toBeGreaterThan(0);
    expect(normal.urgent).toBe(true);
  });
});
