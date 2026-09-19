import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditVapiAssistants } from "./vapi-audit";
import { auditIncidents } from "./vapi-config";

/**
 * Which assistants get audited, and which misconfigurations reach the red banner.
 *
 * These run without touching Vapi: with `VAPI_API_KEY` unset, `auditVapiAssistants` decides
 * its targets and returns before it fetches anything or reads the prompt file. That early
 * return is what makes target selection testable at all — the rest of the module needs a
 * live assistant, and untested target selection is where a whole assistant silently drops
 * out of the audit.
 */
const VARS = ["VAPI_API_KEY", "VAPI_ASSISTANT_ID", "VAPI_CALLBACK_ASSISTANT_ID"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("which assistants get audited", () => {
  it("audits both when the two ids differ", async () => {
    process.env.VAPI_ASSISTANT_ID = "asst_out";
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_cb";
    const r = await auditVapiAssistants();
    expect(r.audits.map((a) => a.label)).toEqual(["check-in assistant", "callback assistant"]);
  });

  it("audits the callback assistant once, not twice, when both ids are the same", async () => {
    // A plausible copy-paste: the callback id is the one added by hand, next to an existing
    // line holding the other id. Auditing it twice is worse than not auditing it — the two
    // targets carry OPPOSITE expectations, so the page would show one assistant twice with
    // contradicting verdicts on the consent tool and the farewell, under duplicate keys.
    process.env.VAPI_ASSISTANT_ID = "asst_same";
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_same";
    const r = await auditVapiAssistants();
    expect(r.audits.map((a) => a.label)).toEqual(["check-in assistant"]);
  });

  it("says so in the red banner rather than quietly dropping it", async () => {
    process.env.VAPI_ASSISTANT_ID = "asst_same";
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_same";
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("same id as VAPI_ASSISTANT_ID"))).toBe(true);
  });

  it("banners an unconfigured callback assistant", async () => {
    process.env.VAPI_ASSISTANT_ID = "asst_out";
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("VAPI_CALLBACK_ASSISTANT_ID"))).toBe(true);
  });

  it("banners an unconfigured check-in assistant, which is the worse case", async () => {
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_cb";
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("VAPI_ASSISTANT_ID is not set"))).toBe(true);
  });

  it("reports a missing API key and verifies nothing", async () => {
    process.env.VAPI_ASSISTANT_ID = "asst_out";
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("VAPI_API_KEY is not set"))).toBe(true);
    expect(r.audits.every((a) => !a.verified)).toBe(true);
    // The rule the whole module rests on: never a tick when it could not look.
    expect(r.audits.every((a) => a.checks.every((c) => c.state === "unknown"))).toBe(true);
  });

  it("labels a callback assistant's rows by its own expectations when there is no API key", async () => {
    process.env.VAPI_ASSISTANT_ID = "asst_out";
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_cb";
    const r = await auditVapiAssistants();
    const callback = r.audits.find((a) => a.label === "callback assistant")!;
    expect(callback.checks.find((c) => c.key === "endCallMessage")!.label).toBe("End Call Message sane");
  });
});

describe("when Vapi cannot be reached", () => {
  /**
   * A DIFFERENT code path from the missing-key case above, and one I initially believed was
   * covered when it was not: mutating the fetch-error branch to drop its expectations broke
   * no test. `fetch` is stubbed rather than called — no live Vapi in unit tests — which is
   * the only way to reach this branch offline.
   */
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof globalThis.fetch;
    process.env.VAPI_API_KEY = "test-key-not-used";
    process.env.VAPI_ASSISTANT_ID = "asst_out";
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_cb";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports every check as unknown, never ok", async () => {
    const r = await auditVapiAssistants();
    expect(r.audits.length).toBe(2);
    expect(r.audits.every((a) => !a.verified)).toBe(true);
    expect(r.audits.every((a) => a.checks.every((c) => c.state === "unknown"))).toBe(true);
  });

  it("keeps each assistant's own row labels while it is unreachable", async () => {
    // The moment nobody can check is the worst moment to start asserting the opposite of
    // what that assistant is actually expected to do.
    const r = await auditVapiAssistants();
    const row = (label: string) =>
      r.audits.find((a) => a.label === label)!.checks.find((c) => c.key === "endCallMessage")!.label;
    expect(row("callback assistant")).toBe("End Call Message sane");
    expect(row("check-in assistant")).toBe("End Call Message empty");
  });

  it("does not leak the underlying error into the rendered detail", async () => {
    // The key has to be in the REJECTION for this to test anything. The first version of
    // this rejected with a plain "network down" and asserted the key was absent — which no
    // implementation could have failed, since the key was never anywhere near the error.
    // undici embeds the request in TLS/connect failures, so this is the realistic shape.
    globalThis.fetch = (() =>
      Promise.reject(new Error("connect ECONNREFUSED; authorization: Bearer test-key-not-used"))) as typeof globalThis.fetch;
    const r = await auditVapiAssistants();
    const detail = r.audits[0].checks[0].detail;
    expect(detail).toContain("could not verify");
    expect(detail).not.toContain("test-key-not-used");
    expect(detail).not.toContain("ECONNREFUSED");
  });
});

describe("when Vapi answers", () => {
  /**
   * The path that renders on a normal day, and the one that was completely unguarded:
   * hardcoding the check-in assistant's expectations onto BOTH targets left all 267 tests
   * passing, while making the callback assistant permanently red — its deliberate
   * "Goodbye." flagged bad, its correctly-absent record_consent flagged bad. The unverified
   * paths had a label-parity test and a control; the verified one had neither.
   *
   * `fetch` resolves from a fixture here. Still no live Vapi.
   */
  let realFetch: typeof globalThis.fetch;

  /**
   * Minimal payloads, distinguishable by id, shaped like the real GET /assistant bodies.
   * Rebuilt in beforeEach, never shared: one test reassigns `bodies.asst_out` to prove the
   * check-in assistant is judged by its own rules, and with a module-scope object that
   * leaked into every test declared after it — silently changing what they exercised, and
   * making one of them pass only because it happened to be declared first.
   */
  let bodies: Record<string, unknown>;

  const freshBodies = (): Record<string, unknown> => ({
    asst_out: {
      name: "Rosie",
      endCallMessage: "",
      endCallPhrases: null,
      endCallFunctionEnabled: true,
      artifactPlan: { recordingEnabled: false },
      model: { messages: [{ role: "system", content: "unused" }], tools: [{ function: { name: "record_consent" } }] },
    },
    asst_cb: {
      name: "Rosie — callback",
      // Everything the callback assistant is SUPPOSED to look like, and all of it wrong for
      // the check-in assistant: a spoken farewell, no consent tool, its own prompt.
      endCallMessage: "Goodbye.",
      endCallPhrases: null,
      endCallFunctionEnabled: true,
      artifactPlan: { recordingEnabled: false },
      model: { messages: [{ role: "system", content: "You are Rosie. Say the first message, then end the call." }] },
    },
  });

  beforeEach(() => {
    bodies = freshBodies();
    realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      const id = String(url).split("/").pop()!;
      return Promise.resolve({ ok: true, json: async () => bodies[id] } as Response);
    }) as typeof globalThis.fetch;
    process.env.VAPI_API_KEY = "test-key-not-used";
    process.env.VAPI_ASSISTANT_ID = "asst_out";
    process.env.VAPI_CALLBACK_ASSISTANT_ID = "asst_cb";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("gives the callback assistant its exemptions, so a correct one is not red", async () => {
    const r = await auditVapiAssistants();
    const cb = r.audits.find((a) => a.label === "callback assistant")!;
    expect(cb.verified).toBe(true);
    expect(cb.checks.filter((c) => c.state === "bad")).toEqual([]);
  });

  it("does not hand those exemptions to the check-in assistant", async () => {
    // The control. Identical payload shape, opposite expectations — if the two targets ever
    // collapse onto one set of defaults, exactly one of these two tests breaks.
    const r = await auditVapiAssistants();
    const out = r.audits.find((a) => a.label === "check-in assistant")!;
    const farewell = out.checks.find((c) => c.key === "endCallMessage")!;
    expect(farewell.state).toBe("ok"); // its endCallMessage is empty, which is what it must be
    const consent = out.checks.find((c) => c.key === "consentTool")!;
    expect(consent.state).toBe("ok"); // and it really does carry record_consent
  });

  it("flags the check-in assistant if it is given the callback's configuration", async () => {
    // Proves the check-in assistant is judged by its own, stricter rules rather than being
    // quietly exempted alongside the callback one.
    bodies.asst_out = bodies.asst_cb;
    const r = await auditVapiAssistants();
    const out = r.audits.find((a) => a.label === "check-in assistant")!;
    const bad = out.checks.filter((c) => c.state === "bad").map((c) => c.key);
    expect(bad).toContain("endCallMessage");
    expect(bad).toContain("consentTool");
  });

  it("compares the check-in prompt against the repo file and the callback's against nothing", async () => {
    const r = await auditVapiAssistants();
    const promptRow = (label: string) =>
      r.audits.find((a) => a.label === label)!.checks.find((c) => c.key === "prompt")!;
    // The callback's prompt is never diffed, so it can never be "bad" for drift.
    expect(promptRow("callback assistant").state).toBe("unknown");
    expect(promptRow("callback assistant").label).toBe("System prompt (no repo baseline)");
    // The check-in assistant's IS diffed — against the real repo file, whose contents this
    // fixture deliberately does not match.
    expect(promptRow("check-in assistant").state).toBe("bad");
  });

  it("labels the consent row by what each assistant is actually expected to carry", async () => {
    // Label parity tests compare the two code paths against each other, so they cannot catch
    // a label that is wrong in BOTH. This asserts the value itself: a row reading
    // "record_consent tool attached" on the callback assistant states the opposite of the
    // exemption it was just granted, even while its state says ok.
    const r = await auditVapiAssistants();
    const consentLabel = (label: string) =>
      r.audits.find((a) => a.label === label)!.checks.find((c) => c.key === "consentTool")!.label;
    expect(consentLabel("callback assistant")).toBe("record_consent not required");
    expect(consentLabel("check-in assistant")).toBe("record_consent tool attached");
  });

  it("produces no incidents for a correctly configured callback assistant", async () => {
    const r = await auditVapiAssistants();
    const cb = r.audits.find((a) => a.label === "callback assistant")!;
    expect(auditIncidents([cb])).toEqual([]);
  });
});

describe("when the repo prompt file cannot be read", () => {
  /**
   * `loadRepoPrompt` joins against `process.cwd()`, so moving cwd is what makes this branch
   * reachable offline. It was the only one of the four incident notes with no test at all:
   * deleting its `incidentNotes.push` left 273/273 passing, which would have let the one
   * check that catches an unpasted prompt fix switch itself off while /admin still read
   * "No active incidents".
   *
   * The failure mode is real, not theoretical — it is what happens if `/admin` stops being
   * covered by `outputFileTracingIncludes` and the file is no longer in the bundle.
   */
  let realFetch: typeof globalThis.fetch;
  let realCwd: string;

  beforeEach(() => {
    realCwd = process.cwd();
    process.chdir(os.tmpdir());
    realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ name: "Rosie", model: { messages: [{ role: "system", content: "anything" }] } }),
      } as Response)) as typeof globalThis.fetch;
    process.env.VAPI_API_KEY = "test-key-not-used";
    process.env.VAPI_ASSISTANT_ID = "asst_out";
  });

  afterEach(() => {
    process.chdir(realCwd);
    globalThis.fetch = realFetch;
  });

  it("banners it instead of quietly not checking", async () => {
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("repo prompt file unavailable"))).toBe(true);
  });

  it("reports the prompt row as unknown rather than matching", async () => {
    const r = await auditVapiAssistants();
    const prompt = r.audits[0].checks.find((c) => c.key === "prompt")!;
    expect(prompt.state).toBe("unknown");
  });

  it("treats a whitespace-only prompt file as unavailable too", async () => {
    // The state `.trim()` was added for, and the only one that distinguishes it from a plain
    // `=== ""`. Without this the mutation `repoPrompt.trim() === ""` -> `repoPrompt === ""`
    // survives the whole suite, and a prompt file that is blank rather than missing
    // silently disables drift detection with a green banner.
    const dir = await mkdtemp(path.join(os.tmpdir(), "vapi-audit-"));
    await mkdir(path.join(dir, "prompts"), { recursive: true });
    await writeFile(path.join(dir, "prompts", "vapi-system-prompt.txt"), "   \n\t\n");
    process.chdir(dir);
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("repo prompt file unavailable"))).toBe(true);
    expect(r.audits[0].checks.find((c) => c.key === "prompt")!.state).toBe("unknown");
  });

  it("does NOT report a readable prompt file as unavailable (control)", async () => {
    // Proves the two assertions above are driven by the file's contents and not by the
    // chdir itself, which would make them pass for any implementation.
    const dir = await mkdtemp(path.join(os.tmpdir(), "vapi-audit-"));
    await mkdir(path.join(dir, "prompts"), { recursive: true });
    await writeFile(path.join(dir, "prompts", "vapi-system-prompt.txt"), "You are Rosie.\n");
    process.chdir(dir);
    const r = await auditVapiAssistants();
    expect(r.incidentNotes.some((n) => n.includes("repo prompt file unavailable"))).toBe(false);
  });

  it("still verifies everything that does not need the file (control)", async () => {
    // Without this, the two assertions above are satisfied by an audit that gave up entirely.
    const r = await auditVapiAssistants();
    expect(r.audits[0].verified).toBe(true);
    expect(r.audits[0].checks.some((c) => c.state !== "unknown")).toBe(true);
  });
});
