"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { instantToLocalInput, localInputToInstant } from "@/lib/localdatetime";

/**
 * Shown before the very first call, while it can still be made a warm one.
 *
 * Everything else about consent is wording. This is the part that actually moves the
 * needle: an older adult who has been told "Rosie will ring you tomorrow morning" is
 * having a different conversation from one answering an unknown synthetic voice that
 * names their daughter and asks to keep a record. The second is indistinguishable in
 * shape from the scam calls this demographic is trained to hang up on.
 *
 * Deliberately not a consent checkbox. The caregiver cannot agree on their parent's
 * behalf — Rosie still asks, on the call, every time — and turning "I told my mum" into a
 * consent record is the exact pattern that gets services like this sued.
 */
export default function PrewarmCard({
  parentName,
  timezone,
  confirmedAt,
  firstCallAfter,
}: {
  parentName: string;
  timezone: string;
  confirmedAt: string | null;
  firstCallAfter: string | null;
}) {
  const [confirmed, setConfirmed] = useState(Boolean(confirmedAt));
  const [when, setWhen] = useState(firstCallAfter ? instantToLocalInput(firstCallAfter, timezone) : "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const router = useRouter();

  async function save() {
    setState("saving");
    setError("");
    try {
      const res = await fetch("/api/parents/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed,
          // Entered as wall-clock time in the parent's zone, like every other time in this
          // app — see lib/localdatetime.ts for why both sides must agree on that.
          first_call_after: when ? localInputToInstant(when, timezone).toISOString() : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Couldn't save that. Please try again.");
        setState("idle");
        return;
      }
      setState("saved");
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Please check your connection.");
      setState("idle");
    }
  }

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 mb-4 text-sm text-sky-900">
      <p className="font-medium">Before the first call</p>
      <p className="mt-1">
        {parentName} is about to get a call from a voice they don&apos;t know. It goes far better
        if you speak to them first — even just &ldquo;someone called Rosie will ring you each
        morning to see how you&apos;re doing.&rdquo; Rosie will still ask their permission on the
        call; this only makes that a conversation they were expecting.
      </p>

      <label className="flex items-start gap-2.5 mt-3">
        <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I&apos;ve told {parentName} to expect these calls</span>
      </label>

      <label className="block mt-3">
        <span className="block text-xs font-medium mb-1">
          Hold the first call until (optional — {parentName}&apos;s local time)
        </span>
        <input
          type="datetime-local"
          className="input max-w-xs"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </label>

      <button
        onClick={save}
        disabled={state === "saving"}
        className="mt-3 bg-sky-900 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-sky-800 transition disabled:opacity-50"
      >
        {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save"}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
