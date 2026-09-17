import { LegalPageShell } from "@/components/MarketingShell";

export default function SmsConsentPage() {
  return (
    <LegalPageShell title="SMS Opt-In &amp; Consent Process">
      <p>
        Caregiver Check-In sends SMS alerts to a family member only when an elderly
        parent misses a scheduled medication check-in call, or the AI check-in call
        detects a health/wellness concern. This page describes exactly how and where
        that opt-in is collected.
      </p>

      <h2>Who signs up, and what they agree to</h2>
      <p>
        The <strong>caregiver</strong> (an adult child or family member) creates an
        account and fills out a setup form for their parent. In that form, the caregiver
        adds each family contact they want notified — name, phone number, and which
        events to alert on. Before the form can be saved, the caregiver must check a
        required consent box for each contact:
      </p>

      <div className="not-prose bg-slate-50 border border-slate-200 rounded-xl p-4 my-2">
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" disabled className="mt-0.5" />
          <span>
            I confirm <strong>[contact name]</strong> has agreed to receive text message
            alerts about <strong>[parent name]</strong>&apos;s care.
          </span>
        </label>
        <p className="text-xs text-slate-400 mt-2">
          Exact checkbox shown on the setup form&apos;s Family step. The form cannot be
          submitted with this unchecked.
        </p>
      </div>

      <h2>What message they&apos;ll receive</h2>
      <p>
        A family contact only receives a text when a check-in was missed or a concern
        was flagged — never marketing messages. Example:
      </p>
      <div className="not-prose bg-slate-50 border border-slate-200 rounded-xl p-4 my-2 text-sm text-slate-700 font-mono">
        Heads up: your parent&apos;s check-in call was missed and retries were
        exhausted. Please check in with them directly.
      </div>

      <h2>Enforcement</h2>
      <p>
        This checkbox is validated both in the browser and on our server — a family
        contact&apos;s phone number is rejected by our API and never saved if the consent
        checkbox was not checked. There is no way to add a texted contact without it.
      </p>

      <h2>Opting out</h2>
      <p>
        A family contact can ask the caregiver to remove them from notifications at any
        time, which deletes their contact record entirely and stops all future messages
        to that number.
      </p>

      <h2>More information</h2>
      <p>
        See our <a href="/privacy">Privacy Policy</a> and{" "}
        <a href="/terms">Terms of Service</a> for how we handle data, or contact{" "}
        <a href="mailto:05102005rajat@gmail.com">05102005rajat@gmail.com</a> with
        questions.
      </p>
    </LegalPageShell>
  );
}
