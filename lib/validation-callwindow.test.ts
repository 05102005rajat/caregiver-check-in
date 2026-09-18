import { describe, expect, it } from "vitest";
import { setupFormSchema } from "@/lib/validation";

const base = {
  caregiver: { name: "A", phone: "+15551234567" },
  parent: { name: "B", phone: "+15551234568", timezone: "America/Los_Angeles", assistant_name: "Rosie" },
  appointments: [], family_contacts: [], watch_items: [],
  rules: { retry_after_minutes: 30, max_retries: 2 },
};
const med = (t: string) => ({ name: "M", dose: "", time_of_day: t, notes: "", description: "", start_date: "", end_date: "" });

describe("medication time must be a time we will actually call", () => {
  it("accepts daytime", () => {
    expect(setupFormSchema.safeParse({ ...base, medications: [med("09:00")] }).success).toBe(true);
    expect(setupFormSchema.safeParse({ ...base, medications: [med("08:00")] }).success).toBe(true);
    // The last minute that still leaves a reachable window (21:00 close minus
    // SLOT_MIN_WINDOW_MINUTES).
    expect(setupFormSchema.safeParse({ ...base, medications: [med("20:45")] }).success).toBe(true);
  });

  it("rejects times the dialer would silently never call", () => {
    for (const t of ["22:48", "03:00", "07:59", "21:00", "23:30"]) {
      const r = setupFormSchema.safeParse({ ...base, medications: [med(t)] });
      expect(r.success, `${t} should be rejected`).toBe(false);
    }
  });

  it("rejects a time too close to the window's close to be reachable", () => {
    // 20:59 used to be accepted. A slot's callable life is clamped to 21:00, so it got a
    // one-minute window that no five-minute cron tick ever landed in: never dialled, and
    // then expired into a "their 8:59pm check-in was missed" safety text to the whole
    // family, every night, for a call the system never attempted.
    for (const t of ["20:46", "20:50", "20:59"]) {
      const r = setupFormSchema.safeParse({ ...base, medications: [med(t)] });
      expect(r.success, `${t} should be rejected`).toBe(false);
    }
  });

  it("says which times are allowed, since the caregiver has to pick another one", () => {
    const r = setupFormSchema.safeParse({ ...base, medications: [med("20:59")] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("20:45");
  });
});
