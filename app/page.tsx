import Link from "next/link";

export default function Home() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16 space-y-16">
      <section className="text-center space-y-6">
        <h1 className="text-3xl font-semibold">Caregiver Check-In</h1>
        <p className="text-gray-600 text-lg">
          Daily automated check-in calls for an aging parent or loved one — so you know
          they&apos;re okay without having to call every day yourself.
        </p>
        <Link
          href="/setup"
          className="inline-block bg-black text-white rounded px-5 py-2.5 font-medium"
        >
          Set up check-ins
        </Link>
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-left max-w-md mx-auto">
          Heads up: text alerts to family are temporarily not sending while our phone
          number finishes carrier verification. Calls, transcripts, and the dashboard all
          work normally in the meantime.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">How it works</h2>
        <ol className="space-y-3 text-gray-600 list-decimal list-inside">
          <li>
            You sign in and fill out a short setup form: your parent&apos;s name and
            phone number, their medications and when they&apos;re due, any upcoming
            appointments, and which family members should be notified.
          </li>
          <li>
            Every day at the times you set, our AI assistant calls your parent, checks in
            on how they&apos;re feeling, confirms they&apos;ve taken their medications,
            and reminds them of any appointments.
          </li>
          <li>
            After the call, you can review the full transcript and summary on your
            dashboard. If something needs attention — a missed medication, a health
            concern, or a missed call — the family contacts you specify are notified. A
            normal, healthy check-in sends no notification at all.
          </li>
        </ol>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Who this is for</h2>
        <p className="text-gray-600">
          Caregiver Check-In is built for adult children and family caregivers who live
          far from an aging parent, or who simply can&apos;t call every single day, but
          still want a reliable daily touchpoint and peace of mind that medications are
          being taken and nothing has gone wrong.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">About &amp; contact</h2>
        <p className="text-gray-600">
          Caregiver Check-In is operated by Rajat Chopra as a sole proprietor, based in
          Irvine, California.
        </p>
        <p className="text-gray-600">
          Questions, feedback, or support requests:{" "}
          <a href="mailto:rajatc1@uci.edu" className="underline">
            rajatc1@uci.edu
          </a>
        </p>
      </section>

      <footer className="border-t border-gray-200 pt-6 flex gap-6 text-sm text-gray-500">
        <Link href="/privacy" className="underline">
          Privacy Policy
        </Link>
        <Link href="/terms" className="underline">
          Terms of Service
        </Link>
      </footer>
    </div>
  );
}
