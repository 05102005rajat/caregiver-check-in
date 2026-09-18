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
    expect(setupFormSchema.safeParse({ ...base, medications: [med("20:59")] }).success).toBe(true);
  });
  it("rejects times the dialer would silently never call", () => {
    for (const t of ["22:48", "03:00", "07:59", "21:00", "23:30"]) {
      const r = setupFormSchema.safeParse({ ...base, medications: [med(t)] });
      expect(r.success, `${t} should be rejected`).toBe(false);
    }
  });
});
