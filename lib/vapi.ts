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
      assistantOverrides: { variableValues, ...(firstMessage ? { firstMessage } : {}) },
      metadata,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vapi call failed (${res.status}): ${body}`);
  }

  return res.json();
}
