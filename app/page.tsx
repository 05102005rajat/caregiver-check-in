import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/MarketingShell";

const STEPS = [
  {
    title: "Tell us the details",
    body: "Your parent's name and number, their medications and when they're due, any upcoming appointments, and which family members should be notified.",
  },
  {
    title: "We call, every day",
    body: "At the times you set, our AI assistant calls your parent, checks in on how they're feeling, confirms medications, and reminds them of appointments.",
  },
  {
    title: "You stay in the loop",
    body: "Review the full transcript and summary on your dashboard any time. If something needs attention, family contacts are notified. A healthy check-in sends nothing at all.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <MarketingHeader />

      <main className="flex-1">
        <section className="max-w-2xl mx-auto px-4 pt-14 pb-10 text-center space-y-6">
          <div className="mx-auto w-12 h-12 rounded-full bg-slate-900 text-white flex items-center justify-center text-xl">
            📞
          </div>
          <div className="space-y-3">
            <h1 className="text-3xl sm:text-4xl font-semibold text-slate-900 tracking-tight">
              Daily check-in calls for the people you love
            </h1>
            <p className="text-slate-500 text-lg max-w-lg mx-auto">
              An AI assistant calls your parent every day, confirms their medications and
              appointments, and only texts you when something actually needs your
              attention.
            </p>
          </div>
          <div>
            <Link
              href="/setup"
              className="inline-block bg-slate-900 text-white rounded-lg px-5 py-2.5 font-medium hover:bg-slate-800 transition"
            >
              Set up check-ins
            </Link>
          </div>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Alerts reach family by text message and email — only when something needs
            attention.
          </p>
        </section>

        <section className="max-w-2xl mx-auto px-4 py-10">
          <h2 className="text-xl font-semibold text-slate-900 mb-5">How it works</h2>
          <div className="space-y-3">
            {STEPS.map((step, i) => (
              <div key={step.title} className="bg-white border border-slate-200 rounded-xl p-4 flex gap-4">
                <div className="w-7 h-7 shrink-0 rounded-full bg-slate-900 text-white text-sm font-medium flex items-center justify-center">
                  {i + 1}
                </div>
                <div>
                  <p className="font-medium text-slate-900">{step.title}</p>
                  <p className="text-slate-500 text-sm mt-0.5">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-2xl mx-auto px-4 py-10">
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-2">Who this is for</h2>
            <p className="text-slate-600">
              Caregiver Check-In is built for adult children and family caregivers who
              live far from an aging parent, or who simply can&apos;t call every single
              day, but still want a reliable daily touchpoint and peace of mind that
              medications are being taken and nothing has gone wrong.
            </p>
          </div>
        </section>

        <section className="max-w-2xl mx-auto px-4 py-10">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-2">
            <h2 className="text-xl font-semibold text-slate-900">About &amp; contact</h2>
            <p className="text-slate-600">
              Caregiver Check-In is operated by Rajat Choudhary as a sole proprietor,
              based in Irvine, California.
            </p>
            <p className="text-slate-600">
              Questions, feedback, or support requests:{" "}
              <a href="mailto:05102005rajat@gmail.com" className="underline text-slate-900">
                05102005rajat@gmail.com
              </a>
            </p>
          </div>
        </section>

        <section className="max-w-2xl mx-auto px-4 pb-10">
          <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-xl p-4">
            Caregiver Check-In is not a medical or emergency service and does not provide
            medical advice. In a medical emergency, call 911 directly — see our{" "}
            <a href="/terms" className="underline text-slate-900">
              Terms of Service
            </a>{" "}
            for details.
          </p>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
