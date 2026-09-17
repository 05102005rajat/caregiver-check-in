"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const OPTIONS = [
  { label: "Today", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
];

export default function PauseControl({ parentName, pausedUntil }: { parentName: string; pausedUntil: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);

  const pausedNow = pausedUntil !== null && new Date(pausedUntil) > new Date();

  async function submit(until: string | null) {
    setBusy(true);
    setError("");
    const res = await fetch("/api/parents/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ until }),
    });
    if (res.ok) {
      setChoosing(false);
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't update. Try again.");
    }
    setBusy(false);
  }

  if (pausedNow) {
    return (
      <div className="rounded-xl border border-slate-300 bg-slate-100 p-4 mb-4">
        <p className="text-sm text-slate-700">
          Check-ins are paused until{" "}
          <strong>
            {new Date(pausedUntil!).toLocaleString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </strong>
          . {parentName} won&apos;t be called and no alerts will be sent.
        </p>
        <button
          type="button"
          onClick={() => submit(null)}
          disabled={busy}
          className="mt-2 text-sm font-medium text-slate-900 underline disabled:opacity-50"
        >
          {busy ? "Resuming…" : "Resume check-ins now"}
        </button>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
    );
  }

  if (!choosing) {
    return (
      <div className="mb-4 text-right">
        <button type="button" onClick={() => setChoosing(true)} className="text-xs text-slate-500 underline hover:text-slate-800">
          Pause check-ins
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
      <p className="text-sm text-slate-700">
        Pause calls to {parentName} — useful if they&apos;re in hospital, travelling, or you&apos;re with them.
      </p>
      <div className="flex flex-wrap gap-2 mt-3">
        {OPTIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            disabled={busy}
            onClick={() => submit(new Date(Date.now() + option.days * 24 * 60 * 60 * 1000).toISOString())}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 hover:border-slate-500 transition disabled:opacity-50"
          >
            {option.label}
          </button>
        ))}
        <button type="button" onClick={() => setChoosing(false)} className="text-sm text-slate-500 px-2">
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
