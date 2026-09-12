import { requireEnv } from "@/lib/env";

/** Sends an SMS via Twilio's REST API, authenticated with an API Key (not the classic Auth Token). */
export async function sendSms(to: string, body: string): Promise<string> {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const apiKeySid = requireEnv("TWILIO_API_KEY_SID");
  const apiKeySecret = requireEnv("TWILIO_API_KEY_SECRET");
  const from = requireEnv("TWILIO_FROM_NUMBER");

  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const basicAuth = Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio SMS failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.sid as string;
}
