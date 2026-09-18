"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Places the test call from the dashboard.
 *
 * This used to live only on /setup, and only after a successful save in that same session —
 * so a caregiver who followed either of the two places that recommend it (the consent
 * banner here, and the SMS sent when a parent declines) arrived at the setup wizard with no
 * such button, and had to walk all seven steps and press Save to reach it. Save fully
 * replaces medications, appointments and contacts, so the recovery path ran through the
 * single most destructive action in the app. Re-obtaining consent is the only way out of
 * the consent gate, so the affordance belongs next to the thing telling you to use it.
 */
export default function TestCallButton({ parentName }: { parentName: string }) {
  const [state, setState] = useState<"idle" | "calling" | "done">("idle");
  const [error, setError] = useState("");
  const router = useRouter();

  async function call() {
    setState("calling");
    setError("");
    try {
      const res = await fetch("/api/parents/test-call", { method: "POST" });
      if (res.ok) {
        setState("done");
        // The new call row should show up in the history below without a manual reload.
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't start the call. Please try again.");
      setState("idle");
    } catch {
      setError("Couldn't reach the server. Please check your connection and try again.");
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <p className="mt-3 text-sm font-medium">
        Calling {parentName} now — Rosie will ask for consent at the start of the call.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <button
        onClick={call}
        disabled={state === "calling"}
        className="bg-amber-900 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-amber-800 transition disabled:opacity-50"
      >
        {state === "calling" ? "Starting call…" : "Call now to ask again"}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
