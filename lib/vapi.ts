import { requireEnv } from "@/lib/env";

interface TriggerCallArgs {
  toNumber: string;
  variableValues: Record<string, string>;
  /** Echoed back on the call object/webhook payload — see app/api/vapi/webhook's fallback lookup. */
  metadata?: Record<string, string>;
}

interface VapiCallResponse {
  id: string;
  [key: string]: unknown;
}

export async function triggerVapiCall({ toNumber, variableValues, metadata }: TriggerCallArgs): Promise<VapiCallResponse> {
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
      assistantOverrides: { variableValues },
      metadata,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vapi call failed (${res.status}): ${body}`);
  }

  return res.json();
}
