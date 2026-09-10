interface TriggerCallArgs {
  toNumber: string;
  variableValues: Record<string, string>;
}

interface VapiCallResponse {
  id: string;
  [key: string]: unknown;
}

export async function triggerVapiCall({ toNumber, variableValues }: TriggerCallArgs): Promise<VapiCallResponse> {
  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      assistantId: process.env.VAPI_ASSISTANT_ID,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: toNumber },
      assistantOverrides: { variableValues },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vapi call failed (${res.status}): ${body}`);
  }

  return res.json();
}
