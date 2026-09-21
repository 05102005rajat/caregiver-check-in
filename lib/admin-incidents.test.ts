import { describe, expect, it } from "vitest";
import { buildIncidents, type IncidentInput } from "./admin-incidents";
import { auditAssistant, unverifiedAudit } from "./vapi-config";

/** A household where nothing is wrong: the banner must stay empty. */
const healthy = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  minutesSinceTick: 2,
  staleAfterMinutes: 15,
  stuckCalls: 0,
  stuckAfterMinutes: 10,
  failedMessages: 0,
  failedCalls: 0,
  unprocessedCalls: 0,
  vapi: { audits: [], incidentNotes: [] },
  ...over,
});

/** The raw GET /assistant payload, kept separate from the audit of it — spreading the
 *  AUDIT into `raw` produces a nonsense object that fails every check, so a test built that
 *  way passes for entirely the wrong reason. */
const cleanPayload = {
  name: "Rosie",
  endCallMessage: "",
  endCallPhrases: null,
  endCallFunctionEnabled: true,
  artifactPlan: { recordingEnabled: false },
  model: {
    messages: [{ role: "system", content: "same" }],
    tools: [{ function: { name: "record_consent" } }],
  },
};

const auditOf = (raw: unknown) =>
  auditAssistant({ id: "asst_1", label: "check-in assistant", raw, repoPrompt: "same" });

const cleanAssistant = auditOf(cleanPayload);

describe("buildIncidents", () => {
  it("says nothing when nothing is wrong", () => {
    // The product's whole promise is that silence means fine. If this ever returns a line
    // for a healthy household, the banner is permanently red and stops being read.
    expect(buildIncidents(healthy())).toEqual([]);
  });

  it("is silent for a fully clean assistant too (control)", () => {
    expect(buildIncidents(healthy({ vapi: { audits: [cleanAssistant], incidentNotes: [] } }))).toEqual([]);
  });

  describe("the scheduler", () => {
    it("reports a stale heartbeat", () => {
      expect(buildIncidents(healthy({ minutesSinceTick: 40 }))[0]).toContain("40 min");
    });

    it("treats an unreadable heartbeat as stale, not as healthy", () => {
      // Never seen a tick is not the same as seen a recent one, and the direction this must
      // fail in is loud.
      const lines = buildIncidents(healthy({ minutesSinceTick: null }));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("unknown amount of time");
    });

    it("does not report a heartbeat inside the window (control)", () => {
      expect(buildIncidents(healthy({ minutesSinceTick: 14.9 }))).toEqual([]);
    });
  });

  it("reports a call that connected but could not be processed", () => {
    // An extraction outage leaves rows that look ordinary. Without this the console says
    // "No active incidents" while every check-in that day went unsummarised.
    const lines = buildIncidents(healthy({ unprocessedCalls: 2 }));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("could not be processed");
  });

  it("reports stuck calls, failed notifications and failed calls", () => {
    const lines = buildIncidents(healthy({ stuckCalls: 2, failedMessages: 3, failedCalls: 1 }));
    expect(lines.some((l) => l.includes("2 call(s) stuck"))).toBe(true);
    expect(lines.some((l) => l.includes("3 notification(s) failed"))).toBe(true);
    expect(lines.some((l) => l.includes("1 call(s) failed outright"))).toBe(true);
  });

  describe("the Vapi audit reaches the banner", () => {
    // The hop that had no test: the audit could produce findings and the page could drop
    // them on the floor with every suite still green.
    it("carries a per-assistant finding through", () => {
      // Exactly one thing wrong, so the assertion below names the defect rather than being
      // satisfied by a payload that fails every check at once.
      const drifted = auditOf({ ...cleanPayload, endCallPhrases: ["goodbye"] });
      const lines = buildIncidents(healthy({ vapi: { audits: [drifted], incidentNotes: [] } }));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("end call phrases");
    });

    it("carries an unverified assistant through", () => {
      const down = unverifiedAudit("asst_cb", "callback assistant", "timeout");
      const lines = buildIncidents(healthy({ vapi: { audits: [down], incidentNotes: [] } }));
      expect(lines).toEqual(["Vapi callback assistant: could not verify configuration"]);
    });

    it("carries the standalone incident notes through", () => {
      // The specific regression: an unconfigured callback assistant is the one that was
      // found in production with recording unset, and dropping this leaves the page reading
      // "No active incidents" while nothing is auditing it.
      const lines = buildIncidents(
        healthy({ vapi: { audits: [], incidentNotes: ["callback assistant not configured for audit"] } })
      );
      expect(lines).toEqual(["callback assistant not configured for audit"]);
    });

    it("keeps both sources, not just one", () => {
      const down = unverifiedAudit("asst_cb", "callback assistant", "timeout");
      const lines = buildIncidents(healthy({ vapi: { audits: [down], incidentNotes: ["note"] } }));
      expect(lines.length).toBe(2);
    });
  });

  it("reports everything wrong at once rather than the first thing", () => {
    const down = unverifiedAudit("asst_cb", "callback assistant", "timeout");
    const lines = buildIncidents(
      healthy({ minutesSinceTick: null, stuckCalls: 1, failedMessages: 1, failedCalls: 1, vapi: { audits: [down], incidentNotes: ["note"] } })
    );
    expect(lines.length).toBe(6);
  });
});
