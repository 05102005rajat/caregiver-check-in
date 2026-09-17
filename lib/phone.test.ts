import { describe, expect, it } from "vitest";
import { toE164 } from "./phone";

describe("toE164", () => {
  it("normalizes what people actually type into the form", () => {
    // The opt-in form's own placeholder. Stored raw, this could never be matched to the
    // number Twilio sends to, making the consent record useless.
    expect(toE164("(949) 555-1234")).toBe("+19495551234");
    expect(toE164("949-555-1234")).toBe("+19495551234");
    expect(toE164("949 555 1234")).toBe("+19495551234");
  });

  it("passes through numbers already in E.164", () => {
    expect(toE164("+19495551234")).toBe("+19495551234");
  });

  it("handles a leading US country code without the plus", () => {
    expect(toE164("1 949 555 1234")).toBe("+19495551234");
  });

  it("rejects junk rather than storing an unusable record", () => {
    expect(toE164("1234567")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("+0123456789")).toBeNull(); // E.164 can't start with 0
  });
});
