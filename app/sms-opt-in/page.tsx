import { LegalPageShell } from "@/components/MarketingShell";
import OptInForm from "./OptInForm";

export const metadata = {
  title: "SMS Alerts Sign-Up · Caregiver Check-In",
  description: "Sign up to receive SMS alerts from Caregiver Check-In about a family member's daily check-in calls.",
};

export default function SmsOptInPage() {
  return (
    <LegalPageShell title="Sign up for text alerts">
      <p>
        <strong>Caregiver Check-In</strong> places a short daily phone call to an older adult to check
        how they&apos;re doing and confirm they&apos;ve taken their medications. If a check-in is missed
        or something sounds concerning, we notify the family members they&apos;ve chosen.
      </p>
      <p>
        Use this form to record your consent to receive those alerts. You&apos;ll start receiving them
        once the family member who set up the check-ins adds you as a contact. Texting is optional —
        you can submit this form without agreeing to receive messages.
      </p>

      <div className="not-prose border border-slate-200 rounded-xl p-5 bg-slate-50 my-2">
        <OptInForm />
      </div>

      <h2>What you&apos;ll receive</h2>
      <p>
        Informational alerts only — never marketing. A message is sent when a scheduled check-in call
        was missed, or when the call suggests something the family should look at. A normal check-in
        sends nothing at all, so most days you should expect no messages.
      </p>
      <div className="not-prose bg-white border border-slate-200 rounded-xl p-4 my-2 text-sm text-slate-700 font-mono">
        Heads up: your parent&apos;s check-in call was missed and retries were exhausted. Please check in
        with them directly.
      </div>

      <h2>Message frequency and cost</h2>
      <p>
        Message frequency varies and is typically no more than a few messages per week. Message and
        data rates may apply.
      </p>

      <h2>How to get help or stop messages</h2>
      <p>
        Reply <strong>HELP</strong> to any message for assistance, or <strong>STOP</strong> to
        unsubscribe immediately. You can also email{" "}
        <a href="mailto:05102005rajat@gmail.com">05102005rajat@gmail.com</a> and we&apos;ll remove your
        number. Opting out stops all future messages to that number.
      </p>

      <h2>Privacy</h2>
      <p>
        We never sell or share your phone number, and mobile opt-in information is not shared with
        third parties for marketing. See our <a href="/privacy">Privacy Policy</a> and{" "}
        <a href="/terms">Terms of Service</a>.
      </p>
    </LegalPageShell>
  );
}
