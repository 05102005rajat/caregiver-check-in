import { LegalPageShell } from "@/components/MarketingShell";

export default function PrivacyPolicy() {
  return (
    <LegalPageShell title="Privacy Policy">
      <p>
        Caregiver Check-In (&quot;we&quot;, &quot;us&quot;) is operated by Rajat
        Choudhary as a sole proprietor, based in Irvine, California. This policy
        explains what information we collect through the service and how it&apos;s
        used.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>Account info: your name, email, and phone number as the caregiver.</li>
        <li>
          Your parent&apos;s name, phone number, timezone, medications, appointments,
          and any family contacts you choose to add for notifications.
        </li>
        <li>
          Written transcripts of the automated check-in calls, and a summary generated
          from each call. We do not retain audio recordings of the calls.
        </li>
      </ul>

      <h2>Consent</h2>
      <p>
        Before any information is gathered on a parent&apos;s first check-in call, our
        AI assistant explicitly identifies itself, says who asked for the calls, and
        asks for their verbal consent to a written record being kept. If consent is
        declined, the call ends immediately, no further check-in questions are asked,
        nothing from that call is stored, and we do not call again. Consent can be
        withdrawn on any later call by telling the assistant to stop.
      </p>

      <h2>How we use it</h2>
      <p>
        Information collected is used solely to operate the check-in service: placing
        scheduled calls, summarizing them, and notifying the family contacts you specify
        when a medication is missed or a concern is detected. We do not sell or share
        this information with advertisers.
      </p>

      <h2>Third-party services we use</h2>
      <p>
        We rely on a small number of third-party providers to operate the service: Vapi
        (voice AI calling), Twilio (SMS delivery), Anthropic (call transcript
        summarization), Twilio SendGrid (email delivery), and Supabase (data storage).
        Each processes only the data necessary to perform their function for us.
      </p>

      <h2>Data retention</h2>
      <p>
        Call transcripts and summaries are retained so caregivers can review check-in
        history. You can request deletion of your account and associated data at any
        time by contacting us below.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data:{" "}
        <a href="mailto:05102005rajat@gmail.com">05102005rajat@gmail.com</a>
      </p>
    </LegalPageShell>
  );
}
