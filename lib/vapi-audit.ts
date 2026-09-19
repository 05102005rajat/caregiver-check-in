import { readFile } from "node:fs/promises";
import path from "node:path";
import { auditAssistant, unverifiedAudit, type AssistantAudit } from "@/lib/vapi-config";

/**
 * Reads the live Vapi assistants and hands them to the pure checker in lib/vapi-config.ts.
 *
 * Strictly read-only: GET only, no PATCH, no POST. This runs on an operator page load, and
 * a page render must never change the thing it is reporting on — least of all a voice
 * assistant that phones an elderly person.
 *
 * Nothing here logs. The payload contains the full system prompt, and the one rule this
 * module cannot break is putting prompt text or anything a person said into a log line.
 */

const VAPI_BASE = "https://api.vapi.ai";
const TIMEOUT_MS = 8000;

/** Which assistants we care about, and what the repo is entitled to assume about each. */
interface Target {
  id: string;
  label: string;
  promptOwnedByRepo: boolean;
  consentToolExpected: boolean;
  spokenFarewellExpected: boolean;
}

export interface VapiAuditResult {
  audits: AssistantAudit[];
  /**
   * Findings that are not about any one assistant but still belong in the red banner — an
   * assistant that is not configured, a prompt file that cannot be read. Each one means a
   * check that is supposed to be watching something is not watching it. (There is no second,
   * quieter tier: an earlier `notes` field held one and was removed when it fell empty.)
   *
   * Deliberately a short, named list and NOT a rule like "every unknown is an incident".
   * An unresolved record_consent tool id is permanently unknown — the assistant payload
   * carries ids, not names — and promoting that would red-banner /admin forever, which is
   * the cry-wolf failure this panel exists to avoid. These two are different: each one
   * means a check that is supposed to be watching something is not watching it at all.
   */
  incidentNotes: string[];
}

async function fetchAssistant(id: string, apiKey: string): Promise<{ raw: unknown } | { error: string }> {
  try {
    const res = await fetch(`${VAPI_BASE}/assistant/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      // Explicit even though this version does not cache fetches by default: a stale audit
      // is a false reassurance, and the default is "auto no cache", not "never cache".
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Vapi returned HTTP ${res.status}` };
    return { raw: await res.json() };
  } catch (err) {
    // The NAME only — not the message, and not the error object. undici embeds request
    // details in connect/TLS failures, including the Authorization header, and this string
    // is rendered on a page and pushed into the incident banner. `err.name` ("TimeoutError",
    // "TypeError") says what went wrong without carrying anything from the request.
    // There is a test that fails if this is ever widened to `err.message`.
    return { error: err instanceof Error ? `request failed (${err.name})` : "request failed" };
  }
}

async function loadRepoPrompt(): Promise<string> {
  try {
    return await readFile(path.join(process.cwd(), "prompts", "vapi-system-prompt.txt"), "utf8");
  } catch {
    // Empty string, not a throw: the other five checks are still worth running, and
    // checkPrompt reports "could not verify" rather than "matches" when it has no baseline.
    // next.config.ts adds this file to the /admin trace so it ships with the deployment.
    return "";
  }
}

export async function auditVapiAssistants(): Promise<VapiAuditResult> {
  const incidentNotes: string[] = [];
  const apiKey = process.env.VAPI_API_KEY;
  const outboundId = process.env.VAPI_ASSISTANT_ID;
  const callbackId = process.env.VAPI_CALLBACK_ASSISTANT_ID;

  const targets: Target[] = [];
  if (outboundId) {
    targets.push({
      id: outboundId,
      label: "check-in assistant",
      promptOwnedByRepo: true,
      // This is the consent path: it asks, and record_consent is what writes the answer down.
      consentToolExpected: true,
      // Rosie already closes in her own words; anything here is a second goodbye.
      spokenFarewellExpected: false,
    });
  } else {
    // Not audited at all is strictly worse than audited-and-unreachable, which does banner.
    incidentNotes.push("VAPI_ASSISTANT_ID is not set — the check-in assistant is not being audited");
  }

  if (callbackId && callbackId === outboundId) {
    // Both variables pointing at one assistant is a plausible copy-paste, and auditing it
    // twice is worse than not auditing it: the two targets carry OPPOSITE expectations, so
    // the page would show the same assistant twice with contradicting verdicts on the
    // consent tool and the farewell, under duplicate React keys.
    incidentNotes.push(
      "VAPI_CALLBACK_ASSISTANT_ID is the same id as VAPI_ASSISTANT_ID — the callback assistant is not being audited"
    );
  } else if (callbackId) {
    targets.push({
      id: callbackId,
      label: "callback assistant",
      // Its prompt lives only in Vapi; the repo has no baseline to diff against.
      promptOwnedByRepo: false,
      // It answers a call back, says one line and hangs up. It never asks for consent and
      // must not carry the tool that records it.
      consentToolExpected: false,
      // Its entire job is to say one line and hang up.
      spokenFarewellExpected: true,
    });
  } else {
    // In the banner, not in small print. An unconfigured callback assistant was quieter than
    // an unreachable one — green at the top, one amber line far below — and the unaudited
    // assistant is precisely the one found in production with recordingEnabled unset, which
    // Vapi treats as recording ON against a privacy page promising the opposite. Red until
    // the id is set is the correct resting state.
    incidentNotes.push("callback assistant not configured for audit (set VAPI_CALLBACK_ASSISTANT_ID)");
  }

  if (!apiKey) {
    return {
      incidentNotes: [...incidentNotes, "VAPI_API_KEY is not set — nothing could be verified"],
      audits: targets.map((t) => unverifiedAudit(t.id, t.label, "VAPI_API_KEY is not set", t)),
    };
  }

  const repoPrompt = await loadRepoPrompt();
  // `.trim()`, matching checkPrompt exactly. Testing `=== ""` here left a whitespace-only
  // file producing an `unknown` check and no note whatsoever — quieter than a missing file,
  // for a state that is just as blind.
  if (repoPrompt.trim() === "") {
    // Banner-worthy for the same reason as the two above: the one check that catches a
    // prompt fix that was never pasted has silently switched itself off, and without this
    // the page still reads "No active incidents" while not verifying the prompt at all.
    incidentNotes.push("repo prompt file unavailable — could not verify prompt drift");
  }

  const audits = await Promise.all(
    targets.map(async (t) => {
      const result = await fetchAssistant(t.id, apiKey);
      // Expectations passed here too, so an unreachable assistant's rows are labelled the
      // same way its reachable ones are — otherwise the callback assistant's farewell row
      // silently flips to "End Call Message empty" the moment Vapi times out.
      if ("error" in result) return unverifiedAudit(t.id, t.label, result.error, t);
      return auditAssistant({
        id: t.id,
        label: t.label,
        raw: result.raw,
        repoPrompt,
        promptOwnedByRepo: t.promptOwnedByRepo,
        consentToolExpected: t.consentToolExpected,
        spokenFarewellExpected: t.spokenFarewellExpected,
      });
    })
  );

  return { audits, incidentNotes };
}
