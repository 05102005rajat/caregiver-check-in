import { describe, expect, it } from "vitest";
import { auditAssistant, auditIncidents, looksLikePlaceholderFarewell, unverifiedAudit } from "./vapi-config";

const REPO_PROMPT = "You are Rosie.\nAsk about medications.\nBe brief.\n";

/**
 * A live assistant payload shaped like Vapi's, in the state we want it in. Every test
 * overrides exactly one thing, so a failure names the setting that broke.
 *
 * `overrides` is applied — a fixture that ignores its own argument is the single most common
 * bug in this repo's verification code, and it produces a suite where every case silently
 * exercises the default. There is a test below that fails if this stops merging.
 */
function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "asst_1",
    name: "Rosie",
    endCallMessage: "",
    endCallPhrases: null,
    endCallFunctionEnabled: true,
    artifactPlan: { recordingEnabled: false, transcriptPlan: { enabled: true } },
    model: {
      messages: [{ role: "system", content: REPO_PROMPT }],
      tools: [{ type: "apiRequest", function: { name: "record_consent" } }],
    },
    ...overrides,
  };
}

const audit = (raw: unknown, extra: Record<string, unknown> = {}) =>
  auditAssistant({ id: "asst_1", label: "check-in assistant", raw, repoPrompt: REPO_PROMPT, ...extra });

const check = (raw: unknown, key: string, extra: Record<string, unknown> = {}) =>
  audit(raw, extra).checks.find((c) => c.key === key)!;

describe("the fixture itself", () => {
  it("applies its overrides", () => {
    // Guards the trap described above: if this regresses, every other test here passes
    // while exercising the same default payload.
    expect(assistant({ endCallMessage: "x" }).endCallMessage).toBe("x");
  });

  it("is fully clean, so any failure below is caused by that test's own override", () => {
    expect(audit(assistant()).checks.every((c) => c.state === "ok")).toBe(true);
  });
});

describe("prompt drift", () => {
  it("matches when live is identical", () => {
    expect(check(assistant(), "prompt").state).toBe("ok");
  });

  it("matches despite trailing whitespace and a missing final newline", () => {
    const live = "You are Rosie.  \nAsk about medications.\nBe brief.";
    expect(check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt").state).toBe("ok");
  });

  it("reports extra leftover lines when live has content the repo dropped", () => {
    // The real case: a dev note that was moved out of the prompt file into lib/greeting.ts
    // but is still live, and still being read by the model.
    const live = REPO_PROMPT + "\nFirst message: the app sets it per call.\n";
    const c = check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("extra leftover");
    expect(c.detail).toContain("1");
  });

  it("reports missing repo lines when a fix was never pasted", () => {
    const live = "You are Rosie.\nBe brief.\n";
    const c = check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("missing");
  });

  it("never puts prompt text in the detail", () => {
    const live = REPO_PROMPT + "\nSECRET LEFTOVER LINE\n";
    const c = check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt");
    expect(c.detail).not.toContain("SECRET");
    expect(c.detail).not.toContain("Rosie");
  });

  it("treats a removed blank line as a match, not as drift", () => {
    // The most likely difference between a repo file and a prompt pasted into a dashboard
    // textarea. Unique-set counts described this as "0 missing, 0 extra" — a permanent red
    // banner containing no information.
    //
    // The repo side needs a blank line for this to exercise anything, which the shared
    // REPO_PROMPT does not have — so both sides are spelled out here rather than reusing it.
    // Without that, this passes as an ordinary exact match and tests nothing.
    const repo = "You are Rosie.\n\nAsk about medications.\nBe brief.\n";
    const live = "You are Rosie.\nAsk about medications.\nBe brief.\n";
    const c = auditAssistant({
      id: "a",
      label: "l",
      raw: assistant({ model: { messages: [{ role: "system", content: live }] } }),
      repoPrompt: repo,
    }).checks.find((x) => x.key === "prompt")!;
    expect(c.state).toBe("ok");
    expect(c.detail).toContain("blank-line");
  });

  it("treats leading indentation drift as a match too", () => {
    const repo = "You are Rosie.\nAsk about medications.\n";
    const live = "  You are Rosie.\n\tAsk about medications.\n";
    const c = auditAssistant({
      id: "a",
      label: "l",
      raw: assistant({ model: { messages: [{ role: "system", content: live }] } }),
      repoPrompt: repo,
    }).checks.find((x) => x.key === "prompt")!;
    expect(c.state).toBe("ok");
  });

  it("calls out reordering as reordering", () => {
    const live = "Ask about medications.\nYou are Rosie.\nBe brief.\n";
    const c = check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("different order");
  });

  it("calls out repetition as repetition", () => {
    const live = "You are Rosie.\nAsk about medications.\nAsk about medications.\nBe brief.\n";
    const c = check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("repeated");
  });

  it("never reports a bad state whose detail is two zeros", () => {
    // The finding, pinned directly: whatever the shape of the drift, the message must say
    // something. Guards every branch at once, including ones added later.
    const variants = [
      "You are Rosie.\nAsk about medications.\nBe brief.",
      "Ask about medications.\nYou are Rosie.\nBe brief.",
      "You are Rosie.\nYou are Rosie.\nAsk about medications.\nBe brief.",
      "You are Rosie.\nBe brief.",
      "You are Rosie.\nAsk about medications.\nBe brief.\nLeftover.",
    ];
    for (const live of variants) {
      const c = check(assistant({ model: { messages: [{ role: "system", content: live }] } }), "prompt");
      expect(c.detail).not.toContain("0 repo line(s) missing, 0 extra");
    }
  });

  it("is unknown, never ok, when there is no repo baseline to compare against", () => {
    expect(auditAssistant({ id: "a", label: "l", raw: assistant(), repoPrompt: "" }).checks.find((c) => c.key === "prompt")!.state).toBe(
      "unknown"
    );
  });

  it("is unknown for an assistant whose prompt the repo does not own", () => {
    const c = check(assistant({ model: { messages: [{ role: "system", content: "something else entirely" }] } }), "prompt", {
      promptOwnedByRepo: false,
    });
    expect(c.state).toBe("unknown");
  });

  it("is bad when the live assistant has no system prompt at all", () => {
    expect(check(assistant({ model: { messages: [] } }), "prompt").state).toBe("bad");
  });
});

describe("recording", () => {
  it("is ok only when explicitly false", () => {
    expect(check(assistant(), "recording").state).toBe("ok");
  });

  it("is bad when unset — Vapi defaults it on", () => {
    // The live bug on the callback assistant. Unset reads as blank in the dashboard and as
    // recording-enabled to Vapi, against a privacy page promising no audio is kept.
    const c = check(assistant({ artifactPlan: undefined }), "recording");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("unset");
  });

  it("is bad when the whole artifactPlan is null", () => {
    expect(check(assistant({ artifactPlan: null }), "recording").state).toBe("bad");
  });

  it("is bad when explicitly true", () => {
    expect(check(assistant({ artifactPlan: { recordingEnabled: true } }), "recording").state).toBe("bad");
  });
});

describe("endCallMessage", () => {
  it("is ok when empty string", () => {
    expect(check(assistant({ endCallMessage: "" }), "endCallMessage").state).toBe("ok");
  });

  it("is ok when null", () => {
    expect(check(assistant({ endCallMessage: null }), "endCallMessage").state).toBe("ok");
  });

  it("catches the pasted placeholder list", () => {
    // Exactly what was live, trailing space and all. This field is spoken aloud.
    const c = check(assistant({ endCallMessage: "goodbye,take care,have a good day " }), "endCallMessage");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("placeholder");
  });

  it("flags any non-empty message on an assistant not expected to speak one", () => {
    expect(check(assistant({ endCallMessage: "Goodbye." }), "endCallMessage").state).toBe("bad");
  });

  it("accepts a real farewell on an assistant whose job is to say one", () => {
    // The callback assistant. Flagging this forever is how an operator learns to scroll past
    // the panel, which is the same failure as a family ignoring alerts.
    const c = check(assistant({ endCallMessage: "Goodbye." }), "endCallMessage", { spokenFarewellExpected: true });
    expect(c.state).toBe("ok");
  });

  it("still catches the placeholder even where a farewell is expected", () => {
    const c = check(assistant({ endCallMessage: "goodbye, take care, have a good day" }), "endCallMessage", {
      spokenFarewellExpected: true,
    });
    expect(c.state).toBe("bad");
  });

  it("never echoes the message text", () => {
    const c = check(assistant({ endCallMessage: "Tell Margaret the results came back" }), "endCallMessage");
    expect(c.detail).not.toContain("Margaret");
  });
});

describe("looksLikePlaceholderFarewell", () => {
  it("is true for the stock list in any spacing or case", () => {
    expect(looksLikePlaceholderFarewell("goodbye,take care,have a good day ")).toBe(true);
    expect(looksLikePlaceholderFarewell("Goodbye, Take Care, Have a good day")).toBe(true);
  });

  it("is false for a single deliberate farewell", () => {
    expect(looksLikePlaceholderFarewell("Goodbye.")).toBe(false);
  });

  it("is false for a deliberate two-clause farewell", () => {
    // On the callback assistant a spoken farewell is the whole job, so flagging this left a
    // red banner clearable only by rewording what Rosie says aloud.
    expect(looksLikePlaceholderFarewell("Goodbye, take care.")).toBe(false);
  });

  it("still catches the three-item list, which is what was actually live", () => {
    expect(looksLikePlaceholderFarewell("goodbye,take care,have a good day")).toBe(true);
  });

  it("is false for a real sentence that happens to contain a comma", () => {
    expect(looksLikePlaceholderFarewell("Take care, and I'll ring you tomorrow")).toBe(false);
  });
});

describe("endCallPhrases", () => {
  it("is ok when null or empty", () => {
    expect(check(assistant({ endCallPhrases: null }), "endCallPhrases").state).toBe("ok");
    expect(check(assistant({ endCallPhrases: [] }), "endCallPhrases").state).toBe("ok");
  });

  it("is bad when set at all — phrases match as substrings of the bot's own speech", () => {
    const c = check(assistant({ endCallPhrases: ["goodbye"] }), "endCallPhrases");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("1 phrase");
  });
});

describe("endCallFunctionEnabled", () => {
  it("is ok only when exactly true", () => {
    expect(check(assistant(), "endCallFunction").state).toBe("ok");
  });

  it("is bad when missing — the assistant cannot hang up at all", () => {
    expect(check(assistant({ endCallFunctionEnabled: undefined }), "endCallFunction").state).toBe("bad");
  });

  it("is bad when false", () => {
    expect(check(assistant({ endCallFunctionEnabled: false }), "endCallFunction").state).toBe("bad");
  });
});

describe("record_consent tool", () => {
  it("is ok when named in model.tools", () => {
    expect(check(assistant(), "consentTool").state).toBe("ok");
  });

  it("is bad when tools are present and it is not among them", () => {
    const c = check(assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }], tools: [{ function: { name: "other" } }] } }), "consentTool");
    expect(c.state).toBe("bad");
  });

  it("is unknown, not bad, when the only tool cannot be named", () => {
    const c = check(
      assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }], tools: [{ unexpectedShape: true }] } }),
      "consentTool"
    );
    expect(c.state).toBe("unknown");
  });

  it("is unknown, not a false red, when model.tools is not an array", () => {
    // The same payload used to go the other way here: "no tools attached at all".
    const c = check(
      assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }], tools: { "0": {} } } }),
      "consentTool"
    );
    expect(c.state).toBe("unknown");
  });

  it("is bad when nothing is attached at all", () => {
    expect(check(assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }] } }), "consentTool").state).toBe("bad");
  });

  it("is unknown — not bad — when the payload carries only tool ids", () => {
    // What the live payload actually looks like: model.tools is empty and model.toolIds
    // holds a uuid. Absence of a name is not evidence the tool is missing.
    const c = check(
      assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }], tools: [], toolIds: ["d11f6245"] } }),
      "consentTool"
    );
    expect(c.state).toBe("unknown");
  });

  it("resolves a tool id when the caller supplies a name map", () => {
    const c = check(
      assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }], tools: [], toolIds: ["d11f6245"] } }),
      "consentTool",
      { toolNamesById: { d11f6245: "record_consent" } }
    );
    expect(c.state).toBe("ok");
  });
});

describe("an assistant that is not on the consent path", () => {
  /**
   * The callback assistant as it actually is: no tools, its own short prompt, and a farewell
   * it is supposed to speak. Every difference from the check-in assistant is a deliberate
   * expectation, not a defect — and if any of them were judged by the check-in assistant's
   * rules, /admin would be red forever the moment the id is configured.
   */
  const callback = (overrides: Record<string, unknown> = {}) =>
    auditAssistant({
      id: "asst_cb",
      label: "callback assistant",
      raw: assistant({
        name: "Rosie — callback",
        endCallMessage: "Goodbye.",
        model: { messages: [{ role: "system", content: "You are Rosie. Say the first message, then end the call." }] },
        ...overrides,
      }),
      repoPrompt: REPO_PROMPT,
      promptOwnedByRepo: false,
      consentToolExpected: false,
      spokenFarewellExpected: true,
    });

  it("is fully non-red on a no-tools payload", () => {
    // The whole point of this fix. `bad` is what banners /admin; `unknown` is honest absence
    // of a claim and is allowed here, because the repo genuinely cannot verify that prompt.
    const a = callback();
    expect(a.checks.filter((c) => c.state === "bad")).toEqual([]);
    expect(a.verified).toBe(true);
  });

  it("reports consentTool as ok, naming why rather than pretending it looked", () => {
    const c = callback().checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("ok");
    expect(c.detail).toContain("not attached");
  });

  it("FLAGS a consent tool attached to an assistant that never asks for consent", () => {
    // The exemption runs one way. A callback assistant carrying record_consent could write a
    // consent row for a call in which nobody was asked anything — a fabricated artifact,
    // which is worse than a missing one.
    const a = callback({
      model: {
        messages: [{ role: "system", content: "cb" }],
        tools: [{ function: { name: "record_consent" } }],
      },
    });
    const c = a.checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("bad");
    expect(auditIncidents([a]).length).toBe(1);
  });

  it("cannot confirm absence from a tool entry it is unable to name", () => {
    // A tool this code cannot name is not a tool that is not there. Reporting "provably
    // absent" from a payload it failed to read is the green-when-it-did-not-look failure.
    const c = callback({
      model: { messages: [{ role: "system", content: "cb" }], tools: [{ unexpectedShape: true }] },
    })
      .checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("unknown");
  });

  it("cannot confirm absence when model.tools is not an array", () => {
    // Verified against the real module: an object-shaped `tools` carrying record_consent
    // rendered a green tick asserting the tool was absent.
    const c = callback({
      model: { messages: [{ role: "system", content: "cb" }], tools: { "0": { function: { name: "record_consent" } } } },
    })
      .checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("unknown");
  });

  it("cannot confirm absence when the model itself is unreadable", () => {
    const c = callback({ model: "not an object" }).checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("unknown");
  });

  it("cannot confirm absence from a tool id it cannot even read", () => {
    const c = callback({
      model: { messages: [{ role: "system", content: "cb" }], tools: [], toolIds: [{ id: "objectShaped" }] },
    })
      .checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("unknown");
  });

  it("cannot confirm absence from a payload that only carries tool ids", () => {
    const c = callback({
      model: { messages: [{ role: "system", content: "cb" }], tools: [], toolIds: ["abc123"] },
    })
      .checks.find((x) => x.key === "consentTool")!;
    expect(c.state).toBe("unknown");
  });

  it("produces no incidents at all", () => {
    expect(auditIncidents([callback()])).toEqual([]);
  });

  it("still goes red on something genuinely wrong", () => {
    // The control. Without it, "non-red" above is satisfied by a card that can never be red.
    const a = callback({ artifactPlan: undefined });
    expect(a.checks.filter((c) => c.state === "bad").map((c) => c.key)).toEqual(["recording"]);
    expect(auditIncidents([a]).length).toBe(1);
  });

  it("still catches a placeholder farewell even though a farewell is expected", () => {
    const a = callback({ endCallMessage: "goodbye,take care,have a good day " });
    expect(a.checks.find((c) => c.key === "endCallMessage")!.state).toBe("bad");
  });

  it("accepts a deliberate two-clause farewell", () => {
    const a = callback({ endCallMessage: "Goodbye, take care." });
    expect(a.checks.find((c) => c.key === "endCallMessage")!.state).toBe("ok");
    expect(auditIncidents([a])).toEqual([]);
  });
});

describe("the check-in assistant is NOT excused", () => {
  it("is still bad on consentTool when it has no tools", () => {
    // consentToolExpected defaults to true, so the exemption cannot leak onto the assistant
    // that actually asks for consent — where a missing tool means consent is spoken about
    // on the call and never written down.
    const c = check(assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }] } }), "consentTool");
    expect(c.state).toBe("bad");
    // Against the wording the exemption ACTUALLY emits. The previous version asserted the
    // absence of "not the consent path", a string this repo stopped producing when the
    // exemption was reworded — so it was satisfied by every possible implementation,
    // including one that leaked the exemption verbatim.
    expect(c.detail).not.toContain("not required");
    expect(c.detail).not.toContain("not attached");
  });

  it("is still unknown on unresolved tool ids", () => {
    const c = check(
      assistant({ model: { messages: [{ role: "system", content: REPO_PROMPT }], tools: [], toolIds: ["d11f6245"] } }),
      "consentTool"
    );
    expect(c.state).toBe("unknown");
  });
});

describe("unverified audits", () => {
  it("marks every check unknown and never ok", () => {
    const a = unverifiedAudit("asst_1", "check-in assistant", "Vapi returned HTTP 500");
    expect(a.verified).toBe(false);
    expect(a.checks.length).toBeGreaterThan(0);
    expect(a.checks.every((c) => c.state === "unknown")).toBe(true);
    expect(a.checks.every((c) => c.detail.includes("could not verify"))).toBe(true);
  });

  it("labels rows the same way the verified audit would for that assistant", () => {
    // The callback assistant's farewell row is "End Call Message sane" when reachable. Before
    // unverifiedAudit shared the label table, an 8s Vapi timeout re-labelled that same row
    // "End Call Message empty" — quietly asserting the opposite of the exemption it is
    // granted when reachable, at the exact moment nobody can check.
    const exp = { spokenFarewellExpected: true, consentToolExpected: false, promptOwnedByRepo: false };
    const down = unverifiedAudit("asst_cb", "callback assistant", "timeout", exp);
    const up = auditAssistant({
      id: "asst_cb",
      label: "callback assistant",
      raw: assistant({ endCallMessage: "Goodbye." }),
      repoPrompt: REPO_PROMPT,
      ...exp,
    });
    expect(down.checks.map((c) => c.label)).toEqual(up.checks.map((c) => c.label));
  });

  it("labels the check-in assistant's farewell row differently, so the table is really per-assistant", () => {
    // Control: if labelFor ignored its expectations, the test above would pass trivially.
    const cb = unverifiedAudit("a", "l", "x", { spokenFarewellExpected: true });
    const checkIn = unverifiedAudit("a", "l", "x", {});
    const row = (a: typeof cb) => a.checks.find((c) => c.key === "endCallMessage")!.label;
    expect(row(cb)).not.toBe(row(checkIn));
  });

  it("covers the same checks a successful audit reports, so nothing silently disappears", () => {
    const good = audit(assistant()).checks.map((c) => c.key).sort();
    const bad = unverifiedAudit("x", "y", "z").checks.map((c) => c.key).sort();
    expect(bad).toEqual(good);
  });

  it("treats a non-object payload as unverified rather than reading fields off it", () => {
    expect(audit("not json").verified).toBe(false);
    expect(audit(null).verified).toBe(false);
    expect(audit([]).verified).toBe(false);
  });
});

describe("auditIncidents", () => {
  it("is empty for a clean assistant", () => {
    expect(auditIncidents([audit(assistant())])).toEqual([]);
  });

  it("reports a could-not-verify as its own incident, not as silence", () => {
    const lines = auditIncidents([unverifiedAudit("a", "callback assistant", "timeout")]);
    expect(lines).toEqual(["Vapi callback assistant: could not verify configuration"]);
  });

  it("names the assistant and the setting for each bad check", () => {
    const lines = auditIncidents([audit(assistant({ endCallPhrases: ["goodbye"] }))]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("check-in assistant");
    expect(lines[0]).toContain("end call phrases");
  });

  it("does not report unknown checks as incidents, only as absent reassurance", () => {
    // An unknown on one check (no repo baseline) should not page anyone, but it must also
    // never be counted as passing. It simply produces no incident line.
    const lines = auditIncidents([audit(assistant(), { promptOwnedByRepo: false })]);
    expect(lines).toEqual([]);
  });
});
