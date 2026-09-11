import { describe, expect, it } from "vitest";
import { isAlreadyProcessed } from "./webhook-utils";

describe("isAlreadyProcessed", () => {
  it("treats completed and failed as already processed (guards against duplicate webhook delivery)", () => {
    expect(isAlreadyProcessed("completed")).toBe(true);
    expect(isAlreadyProcessed("failed")).toBe(true);
  });

  it("treats every other status as not yet processed", () => {
    expect(isAlreadyProcessed("scheduled")).toBe(false);
    expect(isAlreadyProcessed("in_progress")).toBe(false);
    expect(isAlreadyProcessed("no_answer")).toBe(false);
    expect(isAlreadyProcessed(null)).toBe(false);
  });
});
