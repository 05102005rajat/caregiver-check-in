"use client";

import { useState } from "react";
import type { Call, Message } from "@/types/db";

const STATUS_STYLES: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-slate-100 text-slate-600",
  in_progress: "bg-amber-100 text-amber-800",
  no_answer: "bg-orange-100 text-orange-800",
  failed: "bg-red-100 text-red-800",
};

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CallRow({ call, messages = [] }: { call: Call; messages?: Message[] }) {
  const [open, setOpen] = useState(false);
  const status = call.status ?? "scheduled";
  const meds = call.meds_confirmed as { confirmed?: string[]; missed?: string[] } | null;
  // "Accepted by the provider" is not "arrived". A message Twilio took and the carrier
  // then refused (e.g. 30032, unverified toll-free number) must not read as success — a
  // caregiver believing family was told when nothing arrived is the worst failure here.
  const failedAlerts = messages.filter(
    (m) => m.status === "failed" || m.delivery_status === "undelivered" || m.delivery_status === "failed"
  );
  const confirmedAlerts = messages.filter((m) => m.delivery_status === "delivered");
  const pendingAlerts = messages.filter((m) => !failedAlerts.includes(m) && !confirmedAlerts.includes(m));

  return (
    <div className="border border-slate-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-900">{formatDateTime(call.scheduled_for)}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {call.called_at ? `Called ${formatDateTime(call.called_at)}` : "Not yet called"}
            {call.retry_count > 0 ? ` · retry ${call.retry_count}` : ""}
          </p>
        </div>
        <span className={`text-xs font-medium px-2 py-1 rounded-full whitespace-nowrap ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-600"}`}>
          {status.replace("_", " ")}
        </span>
      </div>

      {call.summary && <p className="text-sm text-slate-600 mt-2">{call.summary}</p>}

      {meds && ((meds.confirmed?.length ?? 0) > 0 || (meds.missed?.length ?? 0) > 0) && (
        <div className="text-xs text-slate-500 mt-2 space-y-0.5">
          {meds.confirmed && meds.confirmed.length > 0 && <p>✓ Confirmed: {meds.confirmed.join(", ")}</p>}
          {meds.missed && meds.missed.length > 0 && <p className="text-amber-700">⚠ Not confirmed: {meds.missed.join(", ")}</p>}
        </div>
      )}

      {call.concerns && call.concerns.length > 0 && (
        <p className="text-xs text-red-600 mt-1">Concerns: {call.concerns.join(", ")}</p>
      )}

      {messages.length > 0 && (
        <div className="mt-2 text-xs">
          {failedAlerts.length === 0 ? (
            <div className="text-slate-500 space-y-0.5">
              {confirmedAlerts.length > 0 && (
                <p>✓ Delivered to {confirmedAlerts.map((m) => m.recipient ?? "unknown").join(", ")}</p>
              )}
              {pendingAlerts.length > 0 && (
                <p>
                  Sent to {pendingAlerts.map((m) => m.recipient ?? "unknown").join(", ")}
                  {pendingAlerts.some((m) => m.channel === "sms") ? " — delivery not yet confirmed" : ""}
                </p>
              )}
            </div>
          ) : (
            // A caregiver assuming family was told when the text silently failed is the
            // worst failure this product can have — surface it rather than logging it.
            <p className="text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
              ⚠ {failedAlerts.length} alert{failedAlerts.length === 1 ? "" : "s"} did not reach{" "}
              {failedAlerts.map((m) => m.recipient ?? "unknown").join(", ")} — they were not notified.
              {failedAlerts.some((m) => m.delivery_error) && (
                <span className="block mt-0.5 text-red-600">
                  Carrier error {failedAlerts.find((m) => m.delivery_error)?.delivery_error}.
                </span>
              )}
            </p>
          )}
        </div>
      )}

      {call.transcript && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-slate-500 underline mt-2 hover:text-slate-800"
        >
          {open ? "Hide transcript" : "View transcript"}
        </button>
      )}

      {open && call.transcript && (
        <pre className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3 mt-2 whitespace-pre-wrap max-h-80 overflow-y-auto">
          {call.transcript}
        </pre>
      )}
    </div>
  );
}
