/**
 * Does the live Vapi assistant actually say what the repo thinks it says?
 *
 * Four settings on the voice assistant are dashboard-only state that no code in this repo
 * can enforce, and the dashboard renders "unset" and "grey placeholder" identically. That
 * is not a hypothetical: `End Call Message` held the placeholder farewell list — pasted
 * into the field that is SPOKEN ALOUD — and read as empty to anyone looking at the page,
 * while `recordingEnabled` was unset on the assistant inbound calls reach, and Vapi treats
 * unset as recording ON, against a privacy page promising no audio is retained. Both were
 * invisible until someone read the raw JSON.
 *
 * This module makes that class of lie visible. It is pure: JSON in, findings out. No fetch,
 * no env, no filesystem — so the interesting cases (drift, placeholder, unset vs false) are
 * unit-testable without a live assistant, which is the only way these checks get exercised
 * at all.
 *
 * Nothing here may return prompt text or anything a person said. Details are counts and
 * states. The whole point is a panel an operator can read over someone's shoulder.
 */

export type CheckState = "ok" | "bad" | "unknown";

/**
 * What the repo is entitled to assume about a given assistant. Passed to both the real audit
 * and the unverified one, because a row's LABEL depends on these too and not only its state:
 * see `labelFor`, where all three change the wording of the row they govern.
 */
export interface AuditExpectations {
  /** False when the repo holds no baseline for this assistant's prompt. */
  promptOwnedByRepo?: boolean;
  /** False for an assistant that is not on the consent path. */
  consentToolExpected?: boolean;
  /** True for an assistant whose job includes speaking a farewell before hanging up. */
  spokenFarewellExpected?: boolean;
}

/**
 * The six rows, in render order, and how each is labelled. Shared deliberately: the labels
 * used to be written out twice — once in the checks, once in `unverifiedAudit` — and they
 * had already drifted. An unreachable callback assistant re-labelled its farewell row from
 * "End Call Message sane" to "End Call Message empty", quietly asserting the opposite of the
 * exemption it is granted when reachable. Two hand-maintained copies of one rule is the
 * defect HANDOVER names "one rule, one place".
 */
const CHECK_KEYS = ["prompt", "recording", "endCallPhrases", "endCallMessage", "endCallFunction", "consentTool"] as const;

export type CheckKey = (typeof CHECK_KEYS)[number];

function labelFor(key: CheckKey, exp: AuditExpectations): string {
  switch (key) {
    // Every label that depends on an expectation reads it here. A row must never assert
    // something the caller explicitly disclaimed: "record_consent tool attached" on the
    // callback assistant states the opposite of the exemption it was just granted, which is
    // the same mislabel this table was introduced to kill, one field over.
    case "prompt":
      return exp.promptOwnedByRepo === false ? "System prompt (no repo baseline)" : "System prompt matches repo";
    case "recording":
      return "Audio recording off";
    case "endCallPhrases":
      return "End Call Phrases empty";
    case "endCallMessage":
      return exp.spokenFarewellExpected ? "End Call Message sane" : "End Call Message empty";
    case "endCallFunction":
      return "End Call function enabled";
    case "consentTool":
      return exp.consentToolExpected === false ? "record_consent not required" : "record_consent tool attached";
  }
}

export interface ConfigCheck {
  key: string;
  label: string;
  state: CheckState;
  /** Safe to render and to log: counts and states only, never prompt body or PII. */
  detail: string;
}

export interface AssistantAudit {
  id: string;
  /** What this assistant is FOR, supplied by the caller — not read from the payload. */
  label: string;
  /** The assistant's own name, when the payload had one. */
  name: string | null;
  checks: ConfigCheck[];
  /** `false` when the payload could not be read at all, so nothing below was verified. */
  verified: boolean;
}

/**
 * Farewells Vapi shows as grey placeholder text in the End Call Message field. A value made
 * only of these, comma-joined, is almost certainly the placeholder pasted in by hand rather
 * than a sentence someone wrote — worth calling out separately, because it reads as
 * innocuous in the dashboard and is spoken aloud to an elderly person.
 */
const PLACEHOLDER_FAREWELLS = new Set([
  "goodbye",
  "take care",
  "have a good day",
  "have a nice day",
  "bye",
  "talk to you soon",
]);

export function looksLikePlaceholderFarewell(value: string): boolean {
  const parts = value
    .toLowerCase()
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Three, not two. "Goodbye, take care." is a perfectly ordinary thing to have written,
  // and on the callback assistant — where a spoken farewell is the entire job — flagging it
  // leaves a red banner that can only be cleared by rewording what Rosie says aloud. The
  // live bug was the full three-item list Vapi shows as grey placeholder text.
  return parts.length >= 3 && parts.every((p) => PLACEHOLDER_FAREWELLS.has(p.replace(/[.!]+$/, "")));
}

/** Trailing whitespace and trailing blank lines differ by paste and mean nothing. */
function normalizePrompt(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
}

/** The lines that carry meaning: trimmed, blanks dropped. Order preserved — that matters. */
function meaningfulLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l !== "");
}

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function systemPromptOf(raw: Record<string, unknown>): string | null {
  const model = raw.model;
  if (!model || typeof model !== "object") return null;
  const messages = (model as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (m && typeof m === "object" && (m as Record<string, unknown>).role === "system") {
      const content = (m as Record<string, unknown>).content;
      if (typeof content === "string") return content;
    }
  }
  return null;
}

function checkPrompt(raw: Record<string, unknown>, repoPrompt: string, ownedByRepo: boolean): ConfigCheck {
  const base = { key: "prompt", label: labelFor("prompt", { promptOwnedByRepo: ownedByRepo }) };
  // Only one assistant's prompt lives in this repo. Diffing the callback assistant's own
  // short prompt against prompts/vapi-system-prompt.txt would report enormous drift on
  // every load, which is a false alarm that makes the real one invisible.
  if (!ownedByRepo) {
    return { ...base, state: "unknown", detail: "no repo baseline — this prompt exists only in Vapi" };
  }
  // No baseline means no comparison. Reporting "matches" here would be the exact lie this
  // module exists to catch, one layer up.
  if (repoPrompt.trim() === "") {
    return { ...base, state: "unknown", detail: "could not verify: repo prompt file unavailable" };
  }
  const live = systemPromptOf(raw);
  if (live === null) {
    return { ...base, state: "bad", detail: "no system prompt on the live assistant" };
  }
  const liveLines = trimTrailingBlanks(normalizePrompt(live));
  const repoLines = trimTrailingBlanks(normalizePrompt(repoPrompt));

  if (liveLines.join("\n") === repoLines.join("\n")) {
    return { ...base, state: "ok", detail: `exact match (${repoLines.length} lines)` };
  }

  // Compare the SEQUENCE of meaningful lines before reaching for set arithmetic. A paste
  // into a dashboard textarea routinely loses or gains a blank line, and unique-set counts
  // describe that as "0 missing, 0 extra" — a red banner containing no information, which
  // is worse than no banner at all because an operator learns to scroll past it.
  const liveSeq = meaningfulLines(liveLines);
  const repoSeq = meaningfulLines(repoLines);

  if (liveSeq.join("\n") === repoSeq.join("\n")) {
    return {
      ...base,
      state: "ok",
      detail: `matches (${repoSeq.length} lines; whitespace or blank-line differences only)`,
    };
  }

  // Which direction the drift runs matters more than that it exists. Repo lines absent from
  // live means a fix was never pasted; extra live lines means something was left behind —
  // the dev note that lived in the prompt file before it moved into lib/greeting.ts is the
  // real example, and it is still being fed to the model.
  const liveSet = new Set(liveSeq);
  const repoSet = new Set(repoSeq);
  const missing = repoSeq.filter((l) => !liveSet.has(l)).length;
  const extra = liveSeq.filter((l) => !repoSet.has(l)).length;

  if (missing === 0 && extra > 0) {
    return { ...base, state: "bad", detail: `live has ${extra} extra leftover line(s) the repo file does not` };
  }
  if (missing > 0 && extra === 0) {
    return { ...base, state: "bad", detail: `${missing} repo line(s) missing from live — a fix was not pasted` };
  }
  if (missing === 0 && extra === 0) {
    // Same vocabulary, different arrangement. Set counts cannot see this at all, so it has
    // to be named for what it is: every line is accounted for, but the assistant is not
    // reading them in the order the repo says.
    const sameMultiset = [...liveSeq].sort().join("\n") === [...repoSeq].sort().join("\n");
    return {
      ...base,
      state: "bad",
      detail: sameMultiset
        ? `same ${repoSeq.length} lines in a different order`
        : `same lines, repeated differently (${liveSeq.length} live vs ${repoSeq.length} repo)`,
    };
  }
  return { ...base, state: "bad", detail: `drifted: ${missing} repo line(s) missing, ${extra} extra live line(s)` };
}

function checkRecording(raw: Record<string, unknown>): ConfigCheck {
  const base = { key: "recording", label: labelFor("recording", {}) };
  const plan = raw.artifactPlan;
  const value =
    plan && typeof plan === "object" ? (plan as Record<string, unknown>).recordingEnabled : undefined;
  if (value === false) return { ...base, state: "ok", detail: "explicitly false" };
  if (value === true) return { ...base, state: "bad", detail: "recording is ON — /privacy says no audio is retained" };
  // The live bug. Unset is not off: Vapi defaults it on, and triggerVapiCall's per-call
  // override only covers outbound calls, so an inbound one is recorded.
  return { ...base, state: "bad", detail: "unset — Vapi treats this as ON" };
}

function checkEndCallPhrases(raw: Record<string, unknown>): ConfigCheck {
  const base = { key: "endCallPhrases", label: labelFor("endCallPhrases", {}) };
  const value = raw.endCallPhrases;
  if (value === null || value === undefined) return { ...base, state: "ok", detail: "empty" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { ...base, state: "ok", detail: "empty" };
    // Phrases match as a SUBSTRING of the bot's own transcript, and the prompt tells Rosie
    // to say goodbye mid-conversation, so "goodbye" here hangs up inside a question.
    return { ...base, state: "bad", detail: `${value.length} phrase(s) set — matched as substrings of the bot's speech` };
  }
  return { ...base, state: "unknown", detail: "unexpected type in payload" };
}

function checkEndCallMessage(raw: Record<string, unknown>, spokenFarewellExpected: boolean): ConfigCheck {
  const base = { key: "endCallMessage", label: labelFor("endCallMessage", { spokenFarewellExpected }) };
  const value = raw.endCallMessage;
  if (value === null || value === undefined) return { ...base, state: "ok", detail: "empty" };
  if (typeof value !== "string") return { ...base, state: "unknown", detail: "unexpected type in payload" };
  if (value.trim() === "") return { ...base, state: "ok", detail: "empty" };
  if (looksLikePlaceholderFarewell(value)) {
    return {
      ...base,
      state: "bad",
      detail: "holds Vapi's grey placeholder farewell list — this field is SPOKEN ALOUD",
    };
  }
  // An assistant whose whole job is to say one line and hang up is SUPPOSED to have one, so
  // flagging it forever would train an operator to scroll past this panel — the same way a
  // family stops reading alerts that fire on their normal. Expected-ness is the caller's
  // call; the placeholder check above still applies either way.
  if (spokenFarewellExpected) {
    return { ...base, state: "ok", detail: `set (${value.trim().length} chars), as expected for this assistant` };
  }
  // The length is safe to show; the text is a thing said aloud to a person, so it is not.
  return { ...base, state: "bad", detail: `set (${value.trim().length} chars) — spoken aloud on hang-up` };
}

function checkEndCallFunction(raw: Record<string, unknown>): ConfigCheck {
  const base = { key: "endCallFunction", label: labelFor("endCallFunction", {}) };
  if (raw.endCallFunctionEnabled === true) return { ...base, state: "ok", detail: "enabled" };
  // With phrases empty (as they must be), this is the only way the assistant can hang up.
  // Without it the consent-refusal promise — "I won't ring again" — has no mechanism.
  return { ...base, state: "bad", detail: "not enabled — the assistant cannot end a call deliberately" };
}

/** Tool names this payload can actually prove, plus how many ids it could not resolve. */
function resolveToolNames(
  raw: Record<string, unknown>,
  toolNamesById: Record<string, string>
): { names: string[]; unresolved: number; anyAttached: boolean } {
  const modelIsReadable = Boolean(raw.model) && typeof raw.model === "object";
  const model = modelIsReadable ? (raw.model as Record<string, unknown>) : {};
  const tools = Array.isArray(model.tools) ? model.tools : [];
  // `tools` present but not an array, or a model this code cannot read at all, is a payload
  // it FAILED TO READ — not a payload with no tools. Coercing either to `[]` produced a
  // green "not required, and not attached" for the callback assistant from a payload that
  // may well be carrying record_consent, and a false red "no tools attached at all" for the
  // check-in one. Same defect as the unnameable tool entry and the unreadable tool id; this
  // is the third field it has hidden in.
  const unreadableShape =
    (model.tools !== undefined && !Array.isArray(model.tools) ? 1 : 0) + (raw.model !== undefined && !modelIsReadable ? 1 : 0);
  const rawToolIds = Array.isArray(model.toolIds) ? model.toolIds : [];
  const toolIds = rawToolIds.filter((t): t is string => typeof t === "string");
  // A toolIds entry that is not a string — an object-shaped id, a null — was filtered out
  // before anything counted it: it raised neither `unresolved` nor `anyAttached`, so a
  // payload holding nothing BUT such an entry looked like a payload with no tools. That gave
  // the exemption branch a green "not required, and not attached" about a payload it had
  // failed to read. Same defect as the unnameable `tools` entry below, one field over.
  const unreadableIds = rawToolIds.length - toolIds.length;

  const names: string[] = [];
  let unresolved = 0;
  for (const t of tools) {
    const obj = t && typeof t === "object" ? (t as Record<string, unknown>) : null;
    const fn = obj?.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : {};
    const name = obj ? (obj.name ?? fn.name ?? obj.type) : undefined;
    if (typeof name === "string") names.push(name);
    // A tool this code cannot name is NOT a tool that isn't there. Skipping it silently let
    // `resolveToolNames` report "provably absent" about a payload it had failed to read —
    // and the one-way exemption then rendered a green tick asserting the consent tool is not
    // attached to an assistant that may well be carrying it.
    else unresolved += 1;
  }
  for (const id of toolIds) {
    const name = toolNamesById[id];
    if (name) names.push(name);
    else unresolved += 1;
  }
  unresolved += unreadableIds + unreadableShape;
  return {
    names,
    unresolved,
    anyAttached: tools.length > 0 || rawToolIds.length > 0 || unreadableShape > 0,
  };
}

function checkConsentTool(
  raw: Record<string, unknown>,
  toolNamesById: Record<string, string>,
  expected: boolean
): ConfigCheck {
  const base = { key: "consentTool", label: labelFor("consentTool", { consentToolExpected: expected }) };
  // Not every assistant is on the consent path. The callback assistant answers someone
  // ringing back, says one line and hangs up. Judging it for a MISSING consent tool would
  // red-banner /admin permanently, and a banner that is always red is one nobody reads.
  //
  // The exemption runs one way only. "Not expected" is not "not looked at": an assistant
  // that never asks for consent and nonetheless carries the tool that records it can write a
  // consent row for a call in which nobody was asked anything — a fabricated consent
  // artifact, against the one property migration 0020 exists to establish. So absence is
  // still verified here; only the expectation is inverted.
  if (!expected) {
    const attached = resolveToolNames(raw, toolNamesById);
    if (attached.names.includes("record_consent")) {
      return {
        ...base,
        state: "bad",
        detail: "attached to an assistant that never asks for consent — it could record one that was never given",
      };
    }
    if (attached.unresolved > 0) {
      return {
        ...base,
        state: "unknown",
        detail: `${attached.unresolved} tool id(s); cannot confirm the consent tool is absent from this payload`,
      };
    }
    return { ...base, state: "ok", detail: "not required, and not attached" };
  }

  const { names, unresolved, anyAttached } = resolveToolNames(raw, toolNamesById);
  if (!anyAttached) {
    return { ...base, state: "bad", detail: "no tools attached at all" };
  }

  if (names.some((n) => n === "record_consent")) return { ...base, state: "ok", detail: "present" };
  if (unresolved > 0) {
    // Honest about the limit of this payload: the assistant JSON carries tool IDs, not tool
    // names, so absence here is not evidence of absence.
    return {
      ...base,
      state: "unknown",
      // Permanent, not transient. The assistant payload carries tool IDs and no names, and
      // this panel deliberately does not fetch GET /tool, so this row cannot resolve from
      // what it is given. Worded so nobody reads it as a flaky check worth retrying, and
      // left as `unknown` rather than `bad` because absence of a name is not absence of the
      // tool. `toolNamesById` is the seam if this is ever worth a second request.
      detail: `${unresolved} tool id(s); names are not in the assistant payload, so this cannot be confirmed here`,
    };
  }
  return { ...base, state: "bad", detail: `not among ${names.length} attached tool(s)` };
}

export interface AuditInput {
  id: string;
  label: string;
  /** The parsed body of GET /assistant/{id}. */
  raw: unknown;
  repoPrompt: string;
  /** Optional id → name map, when the caller resolved tools separately. */
  toolNamesById?: Record<string, string>;
  /**
   * False for an assistant whose prompt the repo does not own, so drift cannot be judged.
   */
  promptOwnedByRepo?: boolean;
  /**
   * False for an assistant that is not on the consent path and is not supposed to carry the
   * record_consent tool. Default true: the check-in assistant must have it, and a missing
   * tool there means consent is being spoken about but never written down.
   */
  consentToolExpected?: boolean;
  /**
   * True for an assistant that is meant to speak a farewell and hang up (the callback one).
   * False — the default — for the daily check-in, where Rosie already closes in her own
   * words and anything here is a second goodbye on top.
   */
  spokenFarewellExpected?: boolean;
}

export function auditAssistant({
  id,
  label,
  raw,
  repoPrompt,
  toolNamesById = {},
  promptOwnedByRepo = true,
  consentToolExpected = true,
  spokenFarewellExpected = false,
}: AuditInput): AssistantAudit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return unverifiedAudit(id, label, "assistant payload was not an object");
  }
  const obj = raw as Record<string, unknown>;
  return {
    id,
    label,
    name: typeof obj.name === "string" ? obj.name : null,
    verified: true,
    checks: [
      checkPrompt(obj, repoPrompt, promptOwnedByRepo),
      checkRecording(obj),
      checkEndCallPhrases(obj),
      checkEndCallMessage(obj, spokenFarewellExpected),
      checkEndCallFunction(obj),
      checkConsentTool(obj, toolNamesById, consentToolExpected),
    ],
  };
}

/**
 * What to render when the assistant could not be read: every check `unknown`, never `ok`.
 * A monitor that reports "matches" when it failed to look is worse than no monitor, because
 * it converts an outage into a reassurance — the same shape as the product's own worst bug.
 */
export function unverifiedAudit(
  id: string,
  label: string,
  reason: string,
  expectations: AuditExpectations = {}
): AssistantAudit {
  return {
    id,
    label,
    name: null,
    verified: false,
    checks: CHECK_KEYS.map((key) => ({
      key,
      label: labelFor(key, expectations),
      state: "unknown" as const,
      detail: `could not verify: ${reason}`,
    })),
  };
}

/** Incident lines for the admin banner. Same shape as the cron-stale line beside them. */
export function auditIncidents(audits: AssistantAudit[]): string[] {
  const out: string[] = [];
  for (const a of audits) {
    if (!a.verified) {
      out.push(`Vapi ${a.label}: could not verify configuration`);
      continue;
    }
    const bad = a.checks.filter((c) => c.state === "bad");
    for (const c of bad) out.push(`Vapi ${a.label}: ${c.label.toLowerCase()} — ${c.detail}`);
  }
  return out;
}
