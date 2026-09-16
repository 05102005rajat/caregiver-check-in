import Link from "next/link";

export default function PrivacyPolicy() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16 space-y-6">
      <Link href="/" className="text-sm text-gray-500 underline">
        ← Back home
      </Link>
      <h1 className="text-2xl font-semibold">Privacy Policy</h1>
      <p className="text-sm text-gray-400">Last updated September 2026</p>

      <p className="text-gray-600">
        Caregiver Check-In (&quot;we&quot;, &quot;us&quot;) is operated by Rajat Choudhary as
        a sole proprietor, based in Irvine, California. This policy explains what
        information we collect through the service and how it&apos;s used.
      </p>

      <h2 className="text-lg font-semibold pt-4">What we collect</h2>
      <ul className="list-disc list-inside text-gray-600 space-y-1">
        <li>Account info: your name, email, and phone number as the caregiver.</li>
        <li>
          Your parent&apos;s name, phone number, timezone, medications, appointments,
          and any family contacts you choose to add for notifications.
        </li>
        <li>
          Call recordings and transcripts from the automated check-in calls, and a
          summary generated from each call.
        </li>
      </ul>

      <h2 className="text-lg font-semibold pt-4">Consent to recording</h2>
      <p className="text-gray-600">
        Before any information is gathered on a parent&apos;s first check-in call, our AI
        assistant explicitly asks for their verbal consent to the call being recorded. If
        consent is declined, the call ends immediately and no further check-in questions
        are asked.
      </p>

      <h2 className="text-lg font-semibold pt-4">How we use it</h2>
      <p className="text-gray-600">
        Information collected is used solely to operate the check-in service: placing
        scheduled calls, summarizing them, and notifying the family contacts you specify
        when a medication is missed or a concern is detected. We do not sell or share
        this information with advertisers.
      </p>

      <h2 className="text-lg font-semibold pt-4">Third-party services we use</h2>
      <p className="text-gray-600">
        We rely on a small number of third-party providers to operate the service: Vapi
        (voice AI calling), Twilio (SMS delivery), Anthropic (call transcript
        summarization), Twilio SendGrid (email delivery), and Supabase (data storage).
        Each processes only the data necessary to perform their function for us.
      </p>

      <h2 className="text-lg font-semibold pt-4">Data retention</h2>
      <p className="text-gray-600">
        Call transcripts and summaries are retained so caregivers can review check-in
        history. You can request deletion of your account and associated data at any
        time by contacting us below.
      </p>

      <h2 className="text-lg font-semibold pt-4">Contact</h2>
      <p className="text-gray-600">
        Questions about this policy or your data:{" "}
        <a href="mailto:05102005rajat@gmail.com" className="underline">
          05102005rajat@gmail.com
        </a>
      </p>
    </div>
  );
}
