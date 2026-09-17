import type { Appointment, Medication, WatchItem } from "@/types/db";

export function formatMeds(meds: Medication[]): string {
  if (meds.length === 0) return "none";
  return meds
    .map((m) => {
      const base = m.dose ? `${m.name} (${m.dose})` : m.name;
      // The description helps Rosie describe the pill by appearance/taste/location for a
      // parent who may not recognize it by name, e.g. "the small blue tablet in the left drawer".
      return m.description ? `${base} — ${m.description}` : base;
    })
    .join(", ");
}

export function formatAppointments(appts: Appointment[]): string {
  if (appts.length === 0) return "none";
  return appts.map((a) => a.title).join(", ");
}

/** Watch items for the assistant's prompt — things to ask after by name. */
export function formatWatchItems(items: WatchItem[]): string {
  if (items.length === 0) return "none";
  return items.map((w) => w.description).join("; ");
}
