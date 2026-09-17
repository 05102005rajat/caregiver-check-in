"use client";

import { useState } from "react";

/**
 * Stored verbatim alongside the opt-in, so what someone agreed to stays answerable even
 * after this page is edited. Wording follows Twilio's required elements: who is sending,
 * what kind of messages, frequency, rates, and both HELP and STOP.
 */
export const CONSENT_TEXT =
  "By checking this box, I agree to receive informational SMS text messages from Caregiver Check-In about my family member's daily check-in calls — sent only when a check-in is missed or a concern is detected, typically no more than a few messages per week. Message and data rates may apply. Reply HELP for help or STOP to unsubscribe at any time.";

export default function OptInForm() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError("");
    try {
      const res = await fetch("/api/sms-opt-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, email, consented, consent_text: CONSENT_TEXT }),
      });
      if (res.ok) {
        setStatus("done");
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong. Please try again.");
      setStatus("error");
    } catch {
      setError("Couldn't reach the server. Please check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <p className="font-medium text-emerald-900">Thanks — you&apos;re all set.</p>
        <p className="text-sm text-emerald-800 mt-1">
          {consented
            ? "We've recorded your consent to receive text alerts. You can reply STOP to any message to unsubscribe at any time."
            : "We've recorded your details. You did not opt in to text messages, so we won't send you any."}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-sm font-medium text-slate-700 mb-1.5">Your name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-slate-700 mb-1.5">Email (optional)</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
      </div>

      <label className="block">
        <span className="block text-sm font-medium text-slate-700 mb-1.5">
          Mobile phone number <span className="text-red-600">*</span>
        </span>
        <input
          className="input"
          type="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(949) 555-1234"
          autoComplete="tel"
        />
      </label>

      {/* Unchecked by default, and deliberately NOT required to submit — Twilio's guidance
          is explicit that consent must not gate the form. */}
      <label className="flex items-start gap-2.5 text-sm text-slate-700">
        <input type="checkbox" className="mt-1" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
        <span>{CONSENT_TEXT}</span>
      </label>

      <label className="flex items-start gap-2.5 text-sm text-slate-700">
        <input type="checkbox" className="mt-1" checked={agreedTerms} onChange={(e) => setAgreedTerms(e.target.checked)} />
        <span>
          By checking, I accept the{" "}
          <a href="/terms" className="underline text-slate-900">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="/privacy" className="underline text-slate-900">
            Privacy Policy
          </a>
          .
        </span>
      </label>

      <button
        type="submit"
        disabled={status === "saving"}
        className="bg-slate-900 text-white rounded-lg px-5 py-2.5 font-medium hover:bg-slate-800 transition disabled:opacity-50"
      >
        {status === "saving" ? "Submitting…" : "Continue"}
      </button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <p className="text-xs text-slate-400">
        You can submit this form without agreeing to text messages. We will never share your number, and
        consent is not a condition of any service.
      </p>
    </form>
  );
}
