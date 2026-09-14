import { requireEnv } from "@/lib/env";

/** Sends an email via Twilio SendGrid's REST API. No carrier compliance gate (unlike SMS). */
export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const apiKey = requireEnv("SENDGRID_API_KEY");
  const from = requireEnv("SENDGRID_FROM_EMAIL");

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: "text/plain", value: body }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SendGrid email failed (${res.status}): ${errText}`);
  }

  // SendGrid returns the message id in a response header, not the body, on success (202).
  return res.headers.get("x-message-id") ?? "";
}
