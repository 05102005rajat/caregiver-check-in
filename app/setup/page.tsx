"use client";

import { useEffect, useState } from "react";
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

type Medication = SetupFormPayload["medications"][number];
type Appointment = SetupFormPayload["appointments"][number];
type FamilyContact = SetupFormPayload["family_contacts"][number];

const emptyMed = (): Medication => ({ name: "", dose: "", time_of_day: "", notes: "" });
const emptyAppt = (): Appointment => ({ title: "", starts_at: "", location: "", notes: "" });
const emptyContact = (): FamilyContact => ({
  name: "",
  phone: "",
  role: "other",
  notify_on_miss: true,
  notify_on_concern: true,
});

export default function SetupPage() {
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const [caregiverName, setCaregiverName] = useState("");
  const [caregiverPhone, setCaregiverPhone] = useState("");

  const [parentName, setParentName] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [assistantName, setAssistantName] = useState("Rosie");

  const [medications, setMedications] = useState<Medication[]>([emptyMed()]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [contacts, setContacts] = useState<FamilyContact[]>([emptyContact()]);

  const [retryAfterMinutes, setRetryAfterMinutes] = useState(30);
  const [maxRetries, setMaxRetries] = useState(2);

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError("");

    const payload: SetupFormPayload = {
      caregiver: { name: caregiverName, phone: caregiverPhone },
      parent: {
        name: parentName,
        phone: parentPhone,
        timezone,
        assistant_name: assistantName,
      },
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
      <div className="max-w-lg mx-auto mt-24 text-center space-y-3">
        <h1 className="text-xl font-semibold">You&apos;re all set</h1>
        <p className="text-gray-600">
          {assistantName || "Rosie"} will call {parentName || "your parent"}
          {times ? ` today at ${times}` : ""}.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto my-12 space-y-10 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Set up check-ins</h1>
        {userEmail && <p className="text-sm text-gray-500 mt-1">Signed in as {userEmail}</p>}
      </div>

      <Section title="You">
        <Field label="Your name">
          <input
            required
            className="input"
            value={caregiverName}
            onChange={(e) => setCaregiverName(e.target.value)}
          />
        </Field>
        <Field label="Your phone">
          <input
            required
            placeholder="+15551234567"
            pattern="^\+[1-9]\d{6,14}$"
            title="E.164 format, e.g. +15551234567"
            className="input"
            value={caregiverPhone}
            onChange={(e) => setCaregiverPhone(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Your parent">
        <Field label="Parent's first name">
          <input
            required
            className="input"
            value={parentName}
            onChange={(e) => setParentName(e.target.value)}
          />
        </Field>
        <Field label="Parent's phone">
          <input
            required
            placeholder="+15551234567"
            pattern="^\+[1-9]\d{6,14}$"
            title="E.164 format, e.g. +15551234567"
            className="input"
            value={parentPhone}
            onChange={(e) => setParentPhone(e.target.value)}
          />
        </Field>
        <Field label="Their timezone">
          <select
            className="input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assistant's name">
          <input
            className="input"
            value={assistantName}
            onChange={(e) => setAssistantName(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Medications">
        {medications.map((med, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 items-end">
            <Field label="Name">
              <input
                className="input"
                value={med.name}
                onChange={(e) => updateMed(i, { name: e.target.value })}
              />
            </Field>
            <Field label="Dose">
              <input
                className="input"
                value={med.dose}
                onChange={(e) => updateMed(i, { dose: e.target.value })}
              />
            </Field>
            <Field label="Time of day">
              <input
                type="time"
                className="input"
                value={med.time_of_day}
                onChange={(e) => updateMed(i, { time_of_day: e.target.value })}
              />
            </Field>
            <div className="flex gap-2">
              <Field label="Notes">
                <input
                  className="input"
                  placeholder="with food"
                  value={med.notes}
                  onChange={(e) => updateMed(i, { notes: e.target.value })}
                />
              </Field>
              <button
                type="button"
                onClick={() => setMedications((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-red-600 text-sm mb-2"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {medications.length < 10 && (
          <button
            type="button"
            onClick={() => setMedications((prev) => [...prev, emptyMed()])}
            className="text-sm underline"
          >
            + Add medication
          </button>
        )}
      </Section>

      <Section title="Appointments">
        {appointments.map((appt, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 items-end">
            <Field label="Title">
              <input
                className="input"
                value={appt.title}
                onChange={(e) => updateAppt(i, { title: e.target.value })}
              />
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
              <input
                className="input"
                value={appt.location}
                onChange={(e) => updateAppt(i, { location: e.target.value })}
              />
            </Field>
            <div className="flex gap-2">
              <Field label="Notes">
                <input
                  className="input"
                  value={appt.notes}
                  onChange={(e) => updateAppt(i, { notes: e.target.value })}
                />
              </Field>
              <button
                type="button"
                onClick={() => setAppointments((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-red-600 text-sm mb-2"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {appointments.length < 10 && (
          <button
            type="button"
            onClick={() => setAppointments((prev) => [...prev, emptyAppt()])}
            className="text-sm underline"
          >
            + Add appointment
          </button>
        )}
      </Section>

      <Section title="Family to notify">
        {contacts.map((contact, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 items-end">
            <Field label="Name">
              <input
                className="input"
                value={contact.name}
                onChange={(e) => updateContact(i, { name: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <input
                placeholder="+15551234567"
                pattern="^\+[1-9]\d{6,14}$"
                title="E.164 format, e.g. +15551234567"
                className="input"
                value={contact.phone}
                onChange={(e) => updateContact(i, { phone: e.target.value })}
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
            <label className="flex items-center gap-1 text-sm mb-2">
              <input
                type="checkbox"
                checked={contact.notify_on_miss}
                onChange={(e) => updateContact(i, { notify_on_miss: e.target.checked })}
              />
              Notify on miss
            </label>
            <div className="flex gap-2 items-center">
              <label className="flex items-center gap-1 text-sm mb-2">
                <input
                  type="checkbox"
                  checked={contact.notify_on_concern}
                  onChange={(e) => updateContact(i, { notify_on_concern: e.target.checked })}
                />
                Notify on concern
              </label>
              <button
                type="button"
                onClick={() => setContacts((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-red-600 text-sm mb-2"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {contacts.length < 4 && (
          <button
            type="button"
            onClick={() => setContacts((prev) => [...prev, emptyContact()])}
            className="text-sm underline"
          >
            + Add family contact
          </button>
        )}
      </Section>

      <Section title="Rules">
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
      </Section>

      <div>
        <button
          type="submit"
          disabled={status === "saving"}
          className="bg-black text-white rounded px-4 py-2 disabled:opacity-50"
        >
          {status === "saving" ? "Saving..." : "Save"}
        </button>
        {status === "error" && <p className="text-red-600 text-sm mt-2">{error}</p>}
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-medium mb-3">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-gray-600 mb-1">{label}</span>
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
