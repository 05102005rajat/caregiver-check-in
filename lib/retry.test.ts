import { describe, expect, it } from "vitest";
import { retryDecision } from "./retry";
import type { Call, EscalationRules } from "@/types/db";

function call(overrides: Partial<Call> = {}): Call {
  return {
    id: "c1",
    parent_id: "p1",
    scheduled_for: "2026-09-10T16:00:00.000Z",
    called_at: "2026-09-10T16:00:00.000Z",
    status: "no_answer",
    vapi_call_id: "vapi_1",
    retry_count: 0,
    transcript: null,
    summary: null,
    meds_confirmed: null,
    concerns: null,
    scheduled_meds: null,
    mood: null,
    created_at: "2026-09-10T16:00:00.000Z",
    ...overrides,
  };
}

function rules(overrides: Partial<EscalationRules> = {}): EscalationRules {
  return {
    parent_id: "p1",
    retry_after_minutes: 30,
    max_retries: 2,
    concern_keywords: [],
    ...overrides,
  };
}

describe("retryDecision", () => {
  it("waits if the call was never actually dialed (no called_at)", () => {
    expect(retryDecision(call({ called_at: null }), rules())).toBe("wait");
  });

  it("waits if retry_after_minutes hasn't elapsed yet", () => {
    const calledAt = new Date("2026-09-10T16:00:00Z");
    const now = new Date(calledAt.getTime() + 10 * 60 * 1000); // 10 min later, rules want 30
    expect(retryDecision(call({ called_at: calledAt.toISOString() }), rules(), now)).toBe("wait");
  });

  it("retries once retry_after_minutes has elapsed and retries remain", () => {
    const calledAt = new Date("2026-09-10T16:00:00Z");
    const now = new Date(calledAt.getTime() + 31 * 60 * 1000);
    expect(retryDecision(call({ called_at: calledAt.toISOString(), retry_count: 0 }), rules(), now)).toBe(
      "retry"
    );
  });

  it("is exhausted once retry_count has reached max_retries", () => {
    const calledAt = new Date("2026-09-10T16:00:00Z");
    const now = new Date(calledAt.getTime() + 31 * 60 * 1000);
    const decision = retryDecision(call({ called_at: calledAt.toISOString(), retry_count: 2 }), rules(), now);
    expect(decision).toBe("exhausted");
  });

  it("respects a custom max_retries", () => {
    const calledAt = new Date("2026-09-10T16:00:00Z");
    const now = new Date(calledAt.getTime() + 31 * 60 * 1000);
    const decision = retryDecision(
      call({ called_at: calledAt.toISOString(), retry_count: 4 }),
      rules({ max_retries: 5 }),
      now
    );
    expect(decision).toBe("retry");
  });
});
