import { requireEnv } from "@/lib/env";

/**
 * Where Twilio should report delivery outcomes. Returns null (and so silently skips
 * callbacks) when the app URL or shared secret isn't configured — local development
 * against a laptop has nowhere for Twilio to call back to, and that shouldn't block
 * sending the message itself.
 */
function deliveryCallbackUrl(): string | null {
  const base = process.env.APP_URL;
  const secret = process.env.TWILIO_STATUS_SECRET;
  if (!base || !secret) return null;
  return `${base.replace(/\/$/, "")}/api/twilio/status?secret=${encodeURIComponent(secret)}`;
}

/** Sends an SMS via Twilio's REST API, authenticated with an API Key (not the classic Auth Token). */
export async function sendSms(to: string, body: string): Promise<string> {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const apiKeySid = requireEnv("TWILIO_API_KEY_SID");
  const apiKeySecret = requireEnv("TWILIO_API_KEY_SECRET");
  const from = requireEnv("TWILIO_FROM_NUMBER");

  const params = new URLSearchParams({ To: to, From: from, Body: body });

  // Ask Twilio to report what actually happened to the message. Without this the app only
  // ever knows the request was accepted, which is what let it show "family alerted" for
  // messages the carrier then refused to deliver.
  const statusCallback = deliveryCallbackUrl();
  if (statusCallback) params.set("StatusCallback", statusCallback);
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
