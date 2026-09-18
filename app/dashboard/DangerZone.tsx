"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DangerZone({ parentName }: { parentName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/parents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_name: typed }),
      });
      if (res.ok) {
        router.push("/setup");
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't delete. Try again.");
    } catch {
      // Without this an offline tab sits on "Deleting…" indefinitely, leaving someone
      // unable to tell whether their parent's transcripts were deleted or not.
      setError("Couldn't reach the server — nothing was deleted. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <div className="mt-8 pt-4 border-t border-slate-100 text-right">
        <button type="button" onClick={() => setOpen(true)} className="text-xs text-slate-400 underline hover:text-red-600">
          Delete {parentName}&apos;s data
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 pt-4 border-t border-slate-100">
      <div className="rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-medium text-red-900">Delete {parentName}&apos;s data</p>
        <p className="text-sm text-red-800 mt-1">
          This permanently removes their profile, medications, appointments, contacts, and every call
          check-in history, transcripts, alerts and contacts, along with your own caregiver details. It cannot be undone, and check-in calls will stop. If any of these numbers previously replied STOP to a text, we keep a record of that opt-out so nobody can text them again.
        </p>
        <p className="text-sm text-red-800 mt-2">
          Type <strong>{parentName}</strong> to confirm:
        </p>
        <input
          className="input mt-2 bg-white"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={parentName}
          autoFocus
        />
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={remove}
            disabled={busy || typed.trim().toLowerCase() !== parentName.trim().toLowerCase()}
            className="bg-red-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-red-700 transition disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setTyped("");
              setError("");
            }}
            className="text-sm text-slate-600 px-3"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
      </div>
    </div>
  );
}
