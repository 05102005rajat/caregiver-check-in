"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * "Today" means the rest of today, not the next 24 hours.
 *
 * It sent `now + 24h` like every other option, so clicking it at 9am paused through 9am
 * tomorrow and silently swallowed tomorrow's 08:00 check-in — and the confirmation banner
 * then named tomorrow's date, contradicting the word the caregiver had just clicked. On a
 * product whose entire promise is "no news means they're fine", a skipped day the caregiver
 * didn't ask for is the expensive kind of wrong.
 *
 * Resolved in the parent's timezone, since "today" is their day: a caregiver in London
 * pausing their mother in Los Angeles means the rest of her day, not theirs.
 */
const OPTIONS: Array<{ label: string; until: (timezone: string) => Date }> = [
  { label: "Today", until: (timezone) => endOfLocalDay(timezone) },
  { label: "3 days", until: () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) },
  { label: "1 week", until: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  { label: "2 weeks", until: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
];

/** The instant the parent's local day ends, i.e. their next local midnight. */
function endOfLocalDay(timezone: string): Date {
  const now = new Date();
  // Their current wall-clock time, read back through Intl so this works for any zone the
  // browser isn't in.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // 24:00:00 is how Intl can render midnight with hour12:false; treat it as 0.
  const hours = get("hour") % 24;
  const msElapsed = ((hours * 60 + get("minute")) * 60 + get("second")) * 1000;
  return new Date(now.getTime() + (24 * 60 * 60 * 1000 - msElapsed));
}

export default function PauseControl({
  parentName,
  pausedUntil,
  timezone,
}: {
  parentName: string;
  pausedUntil: string | null;
  timezone: string;
}) {
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
            onClick={() => submit(option.until(timezone).toISOString())}
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
