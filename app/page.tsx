import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/MarketingShell";

const STEPS = [
  {
    title: "Tell us about your loved one",
    body: "Their name and number, what medications are due and when, and who in the family should hear about it.",
  },
  {
    title: "We call them every day",
    body: "A short, friendly conversation at the times you choose — on their ordinary phone, no app and nothing to set up at their end. It's an automated assistant, and it says so plainly if they ask who they're speaking to.",
  },
  {
    title: "You get the important updates",
    body: "A summary on your dashboard after every call, and a text only when something needs you. A good day sends nothing at all.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <MarketingHeader />

      <main className="flex-1">
        <section className="max-w-2xl mx-auto px-4 pt-14 pb-8 text-center space-y-6">
          <div className="mx-auto w-12 h-12 rounded-full bg-slate-900 text-white flex items-center justify-center text-xl">
            📞
          </div>
          <div className="space-y-3">
            <h1 className="text-3xl sm:text-4xl font-semibold text-slate-900 tracking-tight">
              Know how Mom or Dad is doing — without calling every day
            </h1>
            <p className="text-slate-500 text-lg max-w-lg mx-auto">
              An automated voice assistant calls your loved one, has a short conversation,
              and sends you a simple summary when something needs your attention.
            </p>
          </div>
          <div className="space-y-2">
            <Link
              href="/setup"
              className="inline-block bg-slate-900 text-white rounded-lg px-6 py-3 font-medium hover:bg-slate-800 transition"
            >
              Start a free check-in
            </Link>
            <p className="text-sm text-slate-500">
              No app required for your parent. Works with a regular phone.
            </p>
          </div>
        </section>

        {/* The point of this section is that the product is legible in five seconds. It
            mirrors the real dashboard — same wording, same "What changed" panel — rather
            than a tidier invention, so what someone sees here is what they actually get.
            Labelled as an example throughout: it describes nobody. */}
        <section className="max-w-2xl mx-auto px-4 py-6">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2 text-center">
            Example — what you see after a call
          </p>
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-lg font-semibold text-slate-900">Mom is doing okay</p>
                <p className="text-sm text-slate-500 mt-0.5">Last check-in Tue 10:02 AM</p>
              </div>
              <span className="text-2xl leading-none" aria-hidden>
                ✅
              </span>
            </div>

            <p className="text-sm text-slate-600 mt-3">
              Slept well and was up early. Confirmed she took her morning Lisinopril.
              Mentioned she&apos;s having lunch with Susan and planning to pick up groceries
              after.
            </p>

            <div className="mt-4 pt-3 border-t border-slate-200/70">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">
                What changed
              </p>
              <p className="text-sm text-slate-500">
                Nothing new since the last few check-ins — no action needed.
              </p>
            </div>
          </div>
          <p className="text-center text-slate-600 mt-4">
            You don&apos;t need to wonder — and on a day like this, we don&apos;t text you at
            all.
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
          {/* Said here rather than discovered at the end of setup. The first call asks
              permission and waits until you say they're expecting it — that is a reason to
              trust this, not fine print. */}
          <p className="text-sm text-slate-500 mt-4">
            We never cold-call. You tell us when your parent is expecting the first call,
            and on that call we ask their permission before anything else — if they&apos;d
            rather we didn&apos;t, we stop and don&apos;t ring again.
          </p>
        </section>

        <section className="max-w-2xl mx-auto px-4 py-10">
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-2">Who this is for</h2>
            <p className="text-slate-600">
              Adult children and family caregivers who live far from an aging parent, or
              who can&apos;t call every single day, but still want a reliable daily
              touchpoint and to know that medications are being taken.
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
