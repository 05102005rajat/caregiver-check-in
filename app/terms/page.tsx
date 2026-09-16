import Link from "next/link";

export default function TermsOfService() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16 space-y-6">
      <Link href="/" className="text-sm text-gray-500 underline">
        ← Back home
      </Link>
      <h1 className="text-2xl font-semibold">Terms of Service</h1>
      <p className="text-sm text-gray-400">Last updated September 2026</p>

      <p className="text-gray-600">
        Caregiver Check-In is operated by Rajat Chopra as a sole proprietor, based in
        Irvine, California. By using this service, you agree to the following terms.
      </p>

      <h2 className="text-lg font-semibold pt-4">The service</h2>
      <p className="text-gray-600">
        Caregiver Check-In places automated, AI-assisted phone calls to a parent or loved
        one on a schedule you configure, to check on their wellbeing, medications, and
        appointments, and to notify family contacts when something needs attention.
      </p>

      <h2 className="text-lg font-semibold pt-4">Not a medical or emergency service</h2>
      <p className="text-gray-600">
        This service is not a substitute for medical care, medical advice, or emergency
        response. The AI assistant does not diagnose, treat, or provide medical guidance.
        If your parent has a medical emergency, they should call 911 directly — do not
        rely on this service for emergency situations.
      </p>

      <h2 className="text-lg font-semibold pt-4">Consent and recording</h2>
      <p className="text-gray-600">
        You are responsible for ensuring the person being called consents to being
        recorded, consistent with the laws of your state. The assistant asks for verbal
        consent on the first call and will not proceed with check-in questions if consent
        is declined.
      </p>

      <h2 className="text-lg font-semibold pt-4">Accuracy</h2>
      <p className="text-gray-600">
        Call summaries are generated automatically and may not perfectly capture
        everything said during a call. Family contacts should use their own judgment and
        follow up directly with their parent when in doubt, rather than relying solely on
        an automated summary.
      </p>

      <h2 className="text-lg font-semibold pt-4">Changes</h2>
      <p className="text-gray-600">
        We may update these terms as the service evolves. Continued use of the service
        after changes constitutes acceptance of the updated terms.
      </p>

      <h2 className="text-lg font-semibold pt-4">Contact</h2>
      <p className="text-gray-600">
        Questions about these terms:{" "}
        <a href="mailto:rajatc1@uci.edu" className="underline">
          rajatc1@uci.edu
        </a>
      </p>
    </div>
  );
}
