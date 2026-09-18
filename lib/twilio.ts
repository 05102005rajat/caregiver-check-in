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

/**
 * A failed Twilio send, carrying Twilio's numeric error code so callers can act on the
 * specific failure rather than string-matching a message. 21610 in particular means the
 * recipient has texted STOP and the carrier is blocking us — that has to feed back into
 * our own suppression list, not just get logged.
 */
export class TwilioSendError extends Error {
  readonly httpStatus: number;
  readonly code: number | null;

  constructor(httpStatus: number, code: number | null, message: string) {
    super(message);
    this.name = "TwilioSendError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/** Twilio: "Attempt to send to unsubscribed recipient" — i.e. this number replied STOP. */
export const TWILIO_UNSUBSCRIBED = 21610;

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
    // Twilio reports failures as JSON with a numeric `code`; fall back to the raw body if
    // it ever isn't, rather than losing the error entirely to a parse throw.
    let code: number | null = null;
    try {
      const parsed = JSON.parse(errText);
      if (typeof parsed?.code === "number") code = parsed.code;
    } catch {
      // non-JSON body; code stays null
    }
    throw new TwilioSendError(res.status, code, `Twilio SMS failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.sid as string;
}
