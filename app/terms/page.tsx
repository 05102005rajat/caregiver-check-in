import { LegalPageShell } from "@/components/MarketingShell";

export default function TermsOfService() {
  return (
    <LegalPageShell title="Terms of Service">
      <p>
        Caregiver Check-In is operated by Rajat Choudhary as a sole proprietor, based in
        Irvine, California. By using this service, you agree to the following terms.
      </p>

      <h2>The service</h2>
      <p>
        Caregiver Check-In places automated, AI-assisted phone calls to a parent or
        loved one on a schedule you configure, to check on their wellbeing, medications,
        and appointments, and to notify family contacts when something needs attention.
      </p>

      <h2>Not a medical or emergency service</h2>
      <p>
        This service is not a substitute for medical care, medical advice, or emergency
        response. The AI assistant does not diagnose, treat, or provide medical
        guidance. If your parent has a medical emergency, they should call 911 directly
        — do not rely on this service for emergency situations.
      </p>

      <h2>Consent</h2>
      <p>
        You are responsible for ensuring the person being called consents to a written
        record of the call being kept, consistent with the laws of your state. The
        assistant asks for verbal consent on the first call, will not proceed with
        check-in questions if consent is declined, and will not call again. Consent can
        be withdrawn on any later call.
      </p>

      <h2>Accuracy</h2>
      <p>
        Call summaries are generated automatically and may not perfectly capture
        everything said during a call. Family contacts should use their own judgment and
        follow up directly with their parent when in doubt, rather than relying solely
        on an automated summary.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms as the service evolves. Continued use of the service
        after changes constitutes acceptance of the updated terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms:{" "}
        <a href="mailto:05102005rajat@gmail.com">05102005rajat@gmail.com</a>
      </p>
    </LegalPageShell>
  );
}
