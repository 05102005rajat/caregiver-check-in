import type { Appointment, Medication } from "@/types/db";

export function formatMeds(meds: Medication[]): string {
  if (meds.length === 0) return "none";
  return meds.map((m) => (m.dose ? `${m.name} (${m.dose})` : m.name)).join(", ");
}

export function formatAppointments(appts: Appointment[]): string {
  if (appts.length === 0) return "none";
  return appts.map((a) => a.title).join(", ");
}
