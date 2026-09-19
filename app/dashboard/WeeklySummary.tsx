import type { WeeklySummary as Summary } from "@/lib/weekly";

const TONE_TEXT: Record<string, string> = {
  good: "text-slate-700",
  neutral: "text-slate-700",
  watch: "text-slate-900",
};

/**
 * The week at a glance.
 *
 * Sits under the latest call rather than above it: "how is she today" is still the first
 * question, and this answers the slower one behind it. Every line comes from
 * lib/weekly.ts, which reports what was said on the calls and never what is true of the
 * person — the disclaimer is rendered because that distinction is the product's, not the
 * reader's, to maintain.
 */
export default function WeeklySummary({ parentName, summary }: { parentName: string; summary: Summary }) {
  if (summary.empty) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 mb-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-base font-semibold text-slate-900">{parentName}&apos;s week</h2>
        <span className="text-xs text-slate-400">Last 7 days</span>
      </div>

      <ul className="space-y-1.5">
        {summary.lines.map((line, i) => (
          <li key={i} className={`text-sm flex gap-2.5 ${TONE_TEXT[line.tone] ?? "text-slate-700"}`}>
            <span aria-hidden className="shrink-0">
              {line.icon}
            </span>
            <span>{line.text}</span>
          </li>
        ))}
      </ul>

      {summary.worthChecking.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-200/70">
          <p className="text-sm text-slate-900">
            <span className="font-medium">Worth checking on:</span> {summary.worthChecking.join(", ")}
          </p>
        </div>
      )}

      {summary.disclaimer && <p className="text-xs text-slate-400 mt-3">{summary.disclaimer}</p>}
    </div>
  );
}
