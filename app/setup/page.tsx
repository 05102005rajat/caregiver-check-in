"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { FamilyRole, SetupFormPayload } from "@/types/db";

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
];

const FAMILY_ROLES: FamilyRole[] = ["son", "daughter", "spouse", "aide", "other"];

const PHONE_PATTERN = "^\\+[1-9]\\d{6,14}$";

// Most users type a plain 10-digit US number and don't know to prepend "+1" —
// normalize on blur so the E.164 requirement stays invisible to them.
function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

type Medication = SetupFormPayload["medications"][number];
type Appointment = SetupFormPayload["appointments"][number];
type FamilyContact = SetupFormPayload["family_contacts"][number];

const emptyMed = (): Medication => ({
  name: "",
  dose: "",
  time_of_day: "",
  notes: "",
  description: "",
  start_date: "",
  end_date: "",
});
const emptyAppt = (): Appointment => ({ title: "", starts_at: "", location: "", notes: "" });
const emptyContact = (): FamilyContact => ({
  name: "",
  phone: "",
  email: "",
  role: "other",
  notify_on_miss: true,
  notify_on_concern: true,
});

const STEPS = [
  { key: "you", title: "Who's setting this up?", subtitle: "Just your name and number." },
  { key: "parent", title: "Who are we calling?", subtitle: "Your parent's info, and what to call the assistant." },
  { key: "medications", title: "What should we check on?", subtitle: "Medications and when they're due." },
  { key: "appointments", title: "Any appointments?", subtitle: "Optional — skip if there's nothing coming up." },
  { key: "family", title: "Who should we alert?", subtitle: "Optional — family gets texted only if something needs attention." },
  { key: "review", title: "Ready to go", subtitle: "Review, then save." },
] as const;

export default function SetupPage() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const [caregiverName, setCaregiverName] = useState("");
  const [caregiverPhone, setCaregiverPhone] = useState("");

  const [parentName, setParentName] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [assistantName, setAssistantName] = useState("Rosie");

  const [medications, setMedications] = useState<Medication[]>([emptyMed()]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [contacts, setContacts] = useState<FamilyContact[]>([]);

  const [retryAfterMinutes, setRetryAfterMinutes] = useState(30);
  const [maxRetries, setMaxRetries] = useState(2);

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  const [testCallStatus, setTestCallStatus] = useState<"idle" | "calling" | "called" | "error">("idle");
  const [testCallError, setTestCallError] = useState("");

  async function handleTestCall() {
    setTestCallStatus("calling");
    setTestCallError("");
    const res = await fetch("/api/parents/test-call", { method: "POST" });
    if (res.ok) {
      setTestCallStatus("called");
    } else {
      const body = await res.json().catch(() => ({}));
      setTestCallError(body.error ?? "Couldn't place the test call.");
      setTestCallStatus("error");
    }
  }

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  function updateMed(i: number, patch: Partial<Medication>) {
    setMedications((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function updateAppt(i: number, patch: Partial<Appointment>) {
    setAppointments((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function updateContact(i: number, patch: Partial<FamilyContact>) {
    setContacts((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  const phoneValid = (p: string) => new RegExp(PHONE_PATTERN).test(p);
  const canLeaveYouStep = caregiverName.trim().length > 0 && phoneValid(caregiverPhone);
  const canLeaveParentStep = parentName.trim().length > 0 && phoneValid(parentPhone);

  async function handleSave() {
    setStatus("saving");
    setError("");

    const payload: SetupFormPayload = {
      caregiver: { name: caregiverName, phone: caregiverPhone },
      parent: { name: parentName, phone: parentPhone, timezone, assistant_name: assistantName },
      medications: medications.filter((m) => m.name && m.time_of_day),
      appointments: appointments.filter((a) => a.title && a.starts_at),
      family_contacts: contacts.filter((c) => c.name && c.phone),
      rules: { retry_after_minutes: retryAfterMinutes, max_retries: maxRetries },
    };

    const res = await fetch("/api/parents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      setStatus("saved");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong saving your setup.");
      setStatus("error");
    }
  }

  if (status === "saved") {
    const times = medications
      .filter((m) => m.time_of_day)
      .map((m) => formatTime(m.time_of_day))
      .join(" and ");

    return (
      <Shell>
        <div className="text-center space-y-5 py-8">
          <div className="mx-auto w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
            <span className="text-2xl">✓</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">You&apos;re all set</h1>
            <p className="text-slate-500 mt-1.5">
              {assistantName || "Rosie"} will call {parentName || "your parent"}
              {times ? ` today at ${times}` : ""}.
            </p>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={handleTestCall}
              disabled={testCallStatus === "calling"}
              className="bg-slate-900 text-white rounded-lg px-5 py-2.5 font-medium hover:bg-slate-800 transition disabled:opacity-50"
            >
              {testCallStatus === "calling" ? "Calling..." : "Call now to test"}
            </button>
            {testCallStatus === "called" && (
              <p className="text-sm text-slate-500 mt-3">
                {parentName || "Your parent"}&apos;s phone should be ringing now.
              </p>
            )}
            {testCallStatus === "error" && <p className="text-sm text-red-600 mt-3">{testCallError}</p>}
          </div>

          <p className="pt-2">
            <Link href="/dashboard" className="text-sm text-slate-500 underline hover:text-slate-800">
              View call history →
            </Link>
          </p>
        </div>
      </Shell>
    );
  }

  const current = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  function goNext() {
    if (step === 0 && !canLeaveYouStep) return;
    if (step === 1 && !canLeaveParentStep) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  return (
    <Shell>
      <div className="mb-6">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
          <span>
            Step {step + 1} of {STEPS.length}
          </span>
          {userEmail && <span>{userEmail}</span>}
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-slate-900 rounded-full transition-all duration-300"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">{current.title}</h1>
        <p className="text-slate-500 mt-1">{current.subtitle}</p>
      </div>

      <div className="min-h-[280px]">
        {current.key === "you" && (
          <div className="space-y-4">
            <Field label="Your name">
              <input
                autoFocus
                className="input"
                value={caregiverName}
                onChange={(e) => setCaregiverName(e.target.value)}
              />
            </Field>
            <Field label="Your phone">
              <input
                placeholder="9495551234"
                pattern={PHONE_PATTERN}
                title="E.164 format, e.g. +15551234567"
                className="input"
                value={caregiverPhone}
                onChange={(e) => setCaregiverPhone(e.target.value)}
                onBlur={(e) => setCaregiverPhone(normalizePhone(e.target.value))}
              />
              <p className="text-xs text-slate-400 mt-1">Just the 10 digits — we&apos;ll add +1 for you.</p>
            </Field>
          </div>
        )}

        {current.key === "parent" && (
          <div className="space-y-4">
            <Field label="Parent's first name">
              <input
                autoFocus
                className="input"
                value={parentName}
                onChange={(e) => setParentName(e.target.value)}
              />
            </Field>
            <Field label="Parent's phone">
              <input
                placeholder="9495551234"
                pattern={PHONE_PATTERN}
                title="E.164 format, e.g. +15551234567"
                className="input"
                value={parentPhone}
                onChange={(e) => setParentPhone(e.target.value)}
                onBlur={(e) => setParentPhone(normalizePhone(e.target.value))}
              />
              <p className="text-xs text-slate-400 mt-1">Just the 10 digits — we&apos;ll add +1 for you.</p>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Their timezone">
                <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Assistant's name">
                <input className="input" value={assistantName} onChange={(e) => setAssistantName(e.target.value)} />
              </Field>
            </div>
          </div>
        )}

        {current.key === "medications" && (
          <div className="space-y-3">
            {medications.map((med, i) => (
              <Card key={i} onRemove={() => setMedications((prev) => prev.filter((_, idx) => idx !== i))}>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name">
                    <input className="input" value={med.name} onChange={(e) => updateMed(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Dose">
                    <input className="input" value={med.dose} onChange={(e) => updateMed(i, { dose: e.target.value })} />
                  </Field>
                  <Field label="Time of day">
                    <input
                      type="time"
                      className="input"
                      value={med.time_of_day}
                      onChange={(e) => updateMed(i, { time_of_day: e.target.value })}
                    />
                  </Field>
                  <Field label="Notes">
                    <input
                      className="input"
                      placeholder="with food"
                      value={med.notes}
                      onChange={(e) => updateMed(i, { notes: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="How to recognize it (optional)">
                  <input
                    className="input"
                    placeholder="e.g. small blue tablet, bitter, the one in the left drawer"
                    value={med.description}
                    onChange={(e) => updateMed(i, { description: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Start date (optional)">
                    <input
                      type="date"
                      className="input"
                      value={med.start_date}
                      onChange={(e) => updateMed(i, { start_date: e.target.value })}
                    />
                  </Field>
                  <Field label="End date (optional)">
                    <input
                      type="date"
                      className="input"
                      value={med.end_date}
                      onChange={(e) => updateMed(i, { end_date: e.target.value })}
                    />
                  </Field>
                </div>
                <p className="text-xs text-slate-400">
                  Leave both blank for an ongoing medication. Set a range for a short course, like a 7-day antibiotic.
                </p>
              </Card>
            ))}
            {medications.length < 10 && <AddButton onClick={() => setMedications((prev) => [...prev, emptyMed()])}>+ Add medication</AddButton>}
          </div>
        )}

        {current.key === "appointments" && (
          <div className="space-y-3">
            {appointments.map((appt, i) => (
              <Card key={i} onRemove={() => setAppointments((prev) => prev.filter((_, idx) => idx !== i))}>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Title">
                    <input className="input" value={appt.title} onChange={(e) => updateAppt(i, { title: e.target.value })} />
                  </Field>
                  <Field label="Date & time">
                    <input
                      type="datetime-local"
                      className="input"
                      value={appt.starts_at}
                      onChange={(e) => updateAppt(i, { starts_at: e.target.value })}
                    />
                  </Field>
                  <Field label="Location">
                    <input className="input" value={appt.location} onChange={(e) => updateAppt(i, { location: e.target.value })} />
                  </Field>
                  <Field label="Notes">
                    <input className="input" value={appt.notes} onChange={(e) => updateAppt(i, { notes: e.target.value })} />
                  </Field>
                </div>
              </Card>
            ))}
            {appointments.length < 10 && (
              <AddButton onClick={() => setAppointments((prev) => [...prev, emptyAppt()])}>+ Add appointment</AddButton>
            )}
            {appointments.length === 0 && <p className="text-sm text-slate-400">Nothing to add? Just hit Next.</p>}
          </div>
        )}

        {current.key === "family" && (
          <div className="space-y-4">
            <div className="space-y-3">
              {contacts.map((contact, i) => (
                <Card key={i} onRemove={() => setContacts((prev) => prev.filter((_, idx) => idx !== i))}>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Name">
                      <input className="input" value={contact.name} onChange={(e) => updateContact(i, { name: e.target.value })} />
                    </Field>
                    <Field label="Phone">
                      <input
                        placeholder="9495551234"
                        pattern={PHONE_PATTERN}
                        title="E.164 format, e.g. +15551234567"
                        className="input"
                        value={contact.phone}
                        onChange={(e) => updateContact(i, { phone: e.target.value })}
                        onBlur={(e) => updateContact(i, { phone: normalizePhone(e.target.value) })}
                      />
                      <p className="text-xs text-slate-400 mt-1">Just the 10 digits — we&apos;ll add +1 for you.</p>
                    </Field>
                    <Field label="Email (optional, backup alert channel)">
                      <input
                        type="email"
                        placeholder="name@example.com"
                        className="input"
                        value={contact.email}
                        onChange={(e) => updateContact(i, { email: e.target.value })}
                      />
                    </Field>
                    <Field label="Role">
                      <select
                        className="input"
                        value={contact.role}
                        onChange={(e) => updateContact(i, { role: e.target.value as FamilyRole })}
                      >
                        {FAMILY_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="flex gap-4 pt-1">
                    <label className="flex items-center gap-1.5 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={contact.notify_on_miss}
                        onChange={(e) => updateContact(i, { notify_on_miss: e.target.checked })}
                      />
                      Notify on miss
                    </label>
                    <label className="flex items-center gap-1.5 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={contact.notify_on_concern}
                        onChange={(e) => updateContact(i, { notify_on_concern: e.target.checked })}
                      />
                      Notify on concern
                    </label>
                  </div>
                </Card>
              ))}
              {contacts.length < 4 && <AddButton onClick={() => setContacts((prev) => [...prev, emptyContact()])}>+ Add family contact</AddButton>}
              {contacts.length === 0 && <p className="text-sm text-slate-400">No one to notify yet? Just hit Next — you can add this later.</p>}
            </div>

            <div className="pt-2 border-t border-slate-100">
              <p className="text-sm font-medium text-slate-700 mb-3">Retry rules</p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Retry after (minutes)">
                  <input
                    type="number"
                    min={1}
                    className="input"
                    value={retryAfterMinutes}
                    onChange={(e) => setRetryAfterMinutes(Number(e.target.value))}
                  />
                </Field>
                <Field label="Max retries">
                  <input
                    type="number"
                    min={0}
                    className="input"
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value))}
                  />
                </Field>
              </div>
            </div>
          </div>
        )}

        {current.key === "review" && (
          <div className="space-y-3 text-sm">
            <ReviewRow label="You" value={`${caregiverName} · ${caregiverPhone}`} />
            <ReviewRow label="Parent" value={`${parentName} · ${parentPhone} · ${timezone}`} />
            <ReviewRow label="Assistant" value={assistantName} />
            <ReviewRow
              label="Medications"
              value={medications.filter((m) => m.name).length > 0 ? `${medications.filter((m) => m.name).length} added` : "None"}
            />
            <ReviewRow
              label="Appointments"
              value={appointments.filter((a) => a.title).length > 0 ? `${appointments.filter((a) => a.title).length} added` : "None"}
            />
            <ReviewRow
              label="Family to notify"
              value={contacts.filter((c) => c.name).length > 0 ? `${contacts.filter((c) => c.name).length} added` : "None"}
            />
            {status === "error" && <p className="text-red-600 text-sm pt-2">{error}</p>}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-100">
        <button
          type="button"
          onClick={goBack}
          disabled={step === 0}
          className="text-slate-500 font-medium disabled:opacity-0 hover:text-slate-700 transition"
        >
          ← Back
        </button>

        {isLastStep ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={status === "saving"}
            className="bg-slate-900 text-white rounded-lg px-5 py-2.5 font-medium hover:bg-slate-800 transition disabled:opacity-50"
          >
            {status === "saving" ? "Saving..." : "Save"}
          </button>
        ) : (
          <button
            type="button"
            onClick={goNext}
            disabled={(step === 0 && !canLeaveYouStep) || (step === 1 && !canLeaveParentStep)}
            className="bg-slate-900 text-white rounded-lg px-5 py-2.5 font-medium hover:bg-slate-800 transition disabled:opacity-40"
          >
            Next →
          </button>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-lg mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
        {children}
      </div>
    </div>
  );
}

function Card({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3 relative">
      <button type="button" onClick={onRemove} className="absolute top-3 right-3 text-xs text-slate-400 hover:text-red-600 transition">
        Remove
      </button>
      {children}
    </div>
  );
}

function AddButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-slate-600 font-medium border border-dashed border-slate-300 rounded-xl w-full py-2.5 hover:border-slate-400 hover:text-slate-900 transition"
    >
      {children}
    </button>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4 py-2 border-b border-slate-100 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900 font-medium text-right">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${period}`;
}
