import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consentGreeting, returningGreeting } from "./greeting";

const PROMPT = readFileSync(join(import.meta.dirname, "..", "prompts", "vapi-system-prompt.txt"), "utf8");

describe("consentGreeting", () => {
  it("matches the line quoted in the system prompt, variable for variable", () => {
    // Vapi speaks this line as firstMessage, but the assistant's own instructions quote it
    // back so it knows what it just said and can handle the answer. If the two drift, the
    // assistant is told it asked one thing while the person heard another — and on a first
    // call that's the difference between handling a consent answer and ignoring it.
    const rendered = consentGreeting("{{parent_name}}", "{{assistant_name}}", "{{family_setup_by}}");
    expect(PROMPT).toContain(rendered);
  });

  it("names the family member before anything else is asked of them", () => {
    const line = consentGreeting("Margaret", "Rosie", "Anne");
    expect(line.indexOf("Anne")).toBeLessThan(line.indexOf("?"));
  });

  it("discloses recording in plain, active words", () => {
    // "This call may be recorded" is the boilerplate people have learned to tune out, and
    // "may be" reads as evasive. Consent has to actually register to exist (Penal Code
    // §632), so the disclosure must be a plain statement, not a recital.
    const line = consentGreeting("Margaret", "Rosie", "Anne");
    expect(line).toContain("I record our chats");
    expect(line).not.toMatch(/may be recorded/i);
  });

  it("tells them they can refuse", () => {
    // Load-bearing, not decoration: a cornered yes produces a guarded person who gives
    // cheerful untrue answers on every later call, which is the failure this product
    // cannot absorb. Removing this to lift consent rates would be a bad trade.
    expect(consentGreeting("Margaret", "Rosie", "Anne")).toMatch(/say no if you'd rather not/i);
  });

  it("asks exactly one question, so there is one thing to answer", () => {
    expect(consentGreeting("Margaret", "Rosie", "Anne").split("?").length - 1).toBe(1);
  });
});

describe("returningGreeting", () => {
  it("never re-asks for consent once it is on file", () => {
    const line = returningGreeting("Margaret", "Rosie");
    expect(line).not.toMatch(/record|alright|is that ok/i);
  });
});
