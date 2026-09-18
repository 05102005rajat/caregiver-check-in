import { describe, expect, it } from "vitest";
import { SLOT_CATCHUP_MINUTES, coverageStartsAt, planSlotsForDay } from "./slots";
import { isWithinCallingHours } from "./callwindow";
import type { Appointment, Medication } from "@/types/db";

const TZ = "America/Los_Angeles";

function med(overrides: Partial<Medication> = {}): Medication {
  return {
    id: "m1",
    parent_id: "p1",
    name: "Lisinopril",
    dose: "10mg",
    time_of_day: "09:00:00",
    notes: null,
    description: null,
    active: true,
    start_date: null,
    end_date: null,
    created_at: "2026-09-01T00:00:00Z",
    ...overrides,
  } as Medication;
}

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "a1",
    parent_id: "p1",
    title: "Cardiology",
    starts_at: "2026-09-10T22:00:00Z",
    location: null,
    notes: null,
    created_at: "2026-09-01T00:00:00Z",
    ...overrides,
  } as Appointment;
}

// Noon PDT on the 10th, well inside the calling window.
const NOW = new Date("2026-09-10T19:00:00Z");
// Long before anything in these fixtures, so coverage is never the thing under test
// unless a case says so.
const COVERED_SINCE = new Date("2026-09-01T00:00:00Z");

describe("planSlotsForDay", () => {
  it("plans one slot per distinct medication time, carrying every med at that time", () => {
    const { slots } = planSlotsForDay(
      [med({ name: "Lisinopril", time_of_day: "09:00:00" }), med({ id: "m2", name: "Metformin", time_of_day: "09:00:00" }), med({ id: "m3", name: "Statin", time_of_day: "18:00:00" })],
      [],
      TZ,
      NOW,
      COVERED_SINCE
    );
    expect(slots).toHaveLength(2);
    expect(slots.find((s) => s.medNames.length === 2)?.medNames.sort()).toEqual(["Lisinopril", "Metformin"]);
    expect(slots.every((s) => s.kind === "medication")).toBe(true);
  });

  // The whole point of the redesign: "when does this stop being callable" is written down
  // once, as a column, instead of being recomputed against a constant on every tick.
  it("expires a slot the catch-up window after it is due", () => {
    const { slots } = planSlotsForDay([med({ time_of_day: "09:00:00" })], [], TZ, NOW, COVERED_SINCE);
    const slot = slots[0];
    expect(slot.expiresAt.getTime() - slot.dueAt.getTime()).toBe(SLOT_CATCHUP_MINUTES * 60000);
  });

  it("expires an evening slot when the calling window shuts, not two hours later", () => {
    // 20:30 PDT + 2h would be 22:30, an hour and a half after we may legally ring. Without
    // this clamp every tick in between asks for a dial that lib/dial.ts refuses.
    const { slots } = planSlotsForDay([med({ time_of_day: "20:30:00" })], [], TZ, NOW, COVERED_SINCE);
    const slot = slots[0];
    expect(slot.expiresAt.toISOString()).toBe("2026-09-11T04:00:00.000Z"); // 21:00 PDT
    expect(slot.expiresAt.getTime() - slot.dueAt.getTime()).toBeLessThan(SLOT_CATCHUP_MINUTES * 60000);
  });

  it("never plans a slot that is already past its own expiry at planning time", () => {
    for (const timeOfDay of ["08:00:00", "12:00:00", "16:00:00", "20:00:00", "20:45:00"]) {
      for (const { dueAt, expiresAt } of planSlotsForDay([med({ time_of_day: timeOfDay })], [], TZ, NOW, COVERED_SINCE).slots) {
        expect(expiresAt.getTime()).toBeGreaterThan(dueAt.getTime());
        expect(isWithinCallingHours(dueAt, TZ)).toBe(true);
      }
    }
  });

  // These two are the pair that matters most, and the reason coverageStartsAt survived the
  // redesign at all. "The slot already passed" is NOT the same question as "were we
  // responsible for it", and collapsing them loses a real missed check-in.
  it("skips a slot that elapsed before we were responsible (a pause, or a new account)", () => {
    const coveredFrom = new Date("2026-09-10T18:00:00Z"); // 11:00 PDT — after the 09:00 slot
    const { slots } = planSlotsForDay([med({ time_of_day: "09:00:00" })], [], TZ, NOW, coveredFrom);
    expect(slots).toEqual([]);
  });

  it("STILL plans a slot that elapsed while we were responsible (a scheduler outage)", () => {
    // Same elapsed slot, but coverage began long before it. This one is a genuine missed
    // check-in: it must be queued so that expiry can tell the family. A design that only
    // materialised future slots would turn this into silence, which this product renders to
    // a caregiver as "everything is fine".
    const { slots } = planSlotsForDay([med({ time_of_day: "09:00:00" })], [], TZ, NOW, COVERED_SINCE);
    expect(slots).toHaveLength(1);
    expect(slots[0].dueAt.getTime()).toBeLessThan(NOW.getTime());
  });

  it("reports a grandfathered out-of-hours medication instead of queueing it", () => {
    // Predates the calling-hours check in lib/validation.ts. Queueing it would expire
    // unrung every night and text the family daily; dropping it silently is the status quo
    // bug. It comes back as uncallable so the caller can say so.
    const { slots, uncallable } = planSlotsForDay([med({ name: "m1", time_of_day: "22:48:00" })], [], TZ, NOW, COVERED_SINCE);
    expect(slots).toEqual([]);
    expect(uncallable).toEqual([{ reason: "outside_calling_hours", timeOfDay: "22:48:00", medNames: ["m1"] }]);
  });

  it("plans an appointment reminder only when the day has no medication call", () => {
    const withMeds = planSlotsForDay([med({ time_of_day: "09:00:00" })], [appt()], TZ, NOW, COVERED_SINCE);
    expect(withMeds.slots.every((s) => s.kind === "medication")).toBe(true);

    // Same appointment, no medications: this is the appointment-only parent the fallback
    // exists for, who would otherwise never be called at all.
    const withoutMeds = planSlotsForDay([], [appt()], TZ, NOW, COVERED_SINCE);
    expect(withoutMeds.slots).toHaveLength(1);
    expect(withoutMeds.slots[0].kind).toBe("appointment");
    expect(withoutMeds.slots[0].appointmentId).toBe("a1");
  });

  it("collapses two appointments that would land on the same reminder time", () => {
    // The unique (parent_id, due_at) index would reject the second one anyway; planning it
    // twice would just make materialisation noisy.
    const same = new Date("2026-09-10T22:00:00Z").toISOString();
    const { slots } = planSlotsForDay([], [appt({ id: "a1", starts_at: same }), appt({ id: "a2", starts_at: same })], TZ, NOW, COVERED_SINCE);
    expect(slots).toHaveLength(1);
  });

  it("ignores inactive medications and ones outside their start/end dates", () => {
    const { slots } = planSlotsForDay(
      [
        med({ id: "m1", name: "Inactive", active: false }),
        med({ id: "m2", name: "NotStarted", time_of_day: "10:00:00", start_date: "2026-09-20" }),
        med({ id: "m3", name: "Ended", time_of_day: "11:00:00", end_date: "2026-09-01" }),
        med({ id: "m4", name: "EndsToday", time_of_day: "12:00:00", end_date: "2026-09-10" }),
      ],
      [],
      TZ,
      NOW,
      COVERED_SINCE
    );
    // EndsToday must survive: it is still due today. It was dropped by an earlier version
    // of this planner that asked medsDueNow about `now + 24h`, which is tomorrow.
    expect(slots.map((s) => s.medNames).flat()).toEqual(["EndsToday"]);
  });
});

describe("coverageStartsAt", () => {
  it("takes the latest of the four, so the most recent hold wins", () => {
    expect(
      coverageStartsAt({
        paused_until: "2026-09-05T00:00:00Z",
        resumed_at: "2026-09-08T00:00:00Z",
        first_call_after: "2026-09-06T00:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
      }).toISOString()
    ).toBe("2026-09-08T00:00:00.000Z");
  });

  it("uses resumed_at after an explicit resume, which clears paused_until", () => {
    // The Resume button sets paused_until to null rather than moving it. Without resumed_at
    // this collapses to created_at and replays the whole day as missed check-ins.
    expect(
      coverageStartsAt({
        paused_until: null,
        resumed_at: "2026-09-10T18:00:00Z",
        first_call_after: null,
        created_at: "2026-09-01T00:00:00Z",
      }).toISOString()
    ).toBe("2026-09-10T18:00:00.000Z");
  });
});
