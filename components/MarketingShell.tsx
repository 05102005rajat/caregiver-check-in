import Link from "next/link";

export function MarketingHeader() {
  return (
    <header className="max-w-2xl mx-auto px-4 pt-8">
      <Link href="/" className="inline-flex items-center gap-2 text-slate-900 font-semibold">
        <span className="w-7 h-7 rounded-full bg-slate-900 text-white text-sm flex items-center justify-center">
          C
        </span>
        Caregiver Check-In
      </Link>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="max-w-2xl mx-auto px-4 pb-12 pt-6 border-t border-slate-200 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-500">
      <Link href="/privacy" className="hover:text-slate-800 transition">
        Privacy Policy
      </Link>
      <Link href="/terms" className="hover:text-slate-800 transition">
        Terms of Service
      </Link>
      <a href="mailto:05102005rajat@gmail.com" className="hover:text-slate-800 transition">
        05102005rajat@gmail.com
      </a>
    </footer>
  );
}

export function LegalPageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 max-w-2xl mx-auto px-4 py-10 w-full">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-600 transition">
          ← Back home
        </Link>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 mt-4 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
            <p className="text-sm text-slate-400 mt-1">Last updated September 2026</p>
          </div>
          <div className="space-y-6 text-slate-600 leading-relaxed [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_h2]:pt-2 [&_ul]:list-disc [&_ul]:list-inside [&_ul]:space-y-1 [&_a]:underline [&_a]:text-slate-900">
            {children}
          </div>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
