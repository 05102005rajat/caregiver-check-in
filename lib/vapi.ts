import { requireEnv } from "@/lib/env";

interface TriggerCallArgs {
  toNumber: string;
  variableValues: Record<string, string>;
  /** Overrides the assistant's default opening line for this call only. */
  firstMessage?: string;
  /** Echoed back on the call object/webhook payload — see app/api/vapi/webhook's fallback lookup. */
  metadata?: Record<string, string>;
}

interface VapiCallResponse {
  id: string;
  [key: string]: unknown;
}

export async function triggerVapiCall({ toNumber, variableValues, firstMessage, metadata }: TriggerCallArgs): Promise<VapiCallResponse> {
  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("VAPI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      assistantId: requireEnv("VAPI_ASSISTANT_ID"),
      phoneNumberId: requireEnv("VAPI_PHONE_NUMBER_ID"),
      customer: { number: toNumber },
      assistantOverrides: {
        variableValues,
        ...(firstMessage ? { firstMessage } : {}),
        // "We do not retain audio recordings of the calls" is published in the privacy
        // policy, and the consent line Rosie speaks was reworded around it. Until now that
        // guarantee rested entirely on a checkbox in the Vapi dashboard: no code set it, no
        // test asserted it, and nothing would notice if someone toggled it back or pointed
        // VAPI_ASSISTANT_ID at a different assistant. A promise to an 80-year-old about
        // what is kept of their conversation should not be one console click from being
        // false, so it is set per call here as well.
        //
        // transcriptPlan stays enabled: the entire pipeline reads artifact.transcript, and
        // disabling it would make every call come back empty and be recorded as no_answer.
        artifactPlan: { recordingEnabled: false, transcriptPlan: { enabled: true } },
      },
      metadata,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vapi call failed (${res.status}): ${body}`);
  }

  return res.json();
}
