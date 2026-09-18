import { describe, expect, it } from "vitest";
import { SLOT_CATCHUP_MINUTES, coverageStartsAt, medsForNearestSlot, medsForSlot, planSlotsForDay } from "./slots";
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

  it("never lets a slot outlive the calling window it belongs to", () => {
    // The real property. An earlier version of this test asserted only
    // isWithinCallingHours(dueAt) — the exact predicate the planner already filters on, so
    // it restated the filter instead of checking the expiry, and could not fail.
    for (const timeOfDay of ["08:00:00", "12:00:00", "16:00:00", "20:00:00", "20:45:00", "20:59:00"]) {
      for (const { dueAt, expiresAt } of planSlotsForDay([med({ time_of_day: timeOfDay })], [], TZ, NOW, COVERED_SINCE).slots) {
        expect(expiresAt.getTime()).toBeGreaterThan(dueAt.getTime());
        // 21:00 PDT on the slot's own day, i.e. the window close — never past it.
        expect(expiresAt.getTime()).toBeLessThanOrEqual(new Date("2026-09-11T04:00:00.000Z").getTime());
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

  it("plans an appointment reminder for a parent with no medications at all", () => {
    // The appointment-only parent the fallback exists for, who would otherwise never be
    // called.
    const { slots } = planSlotsForDay([], [appt()], TZ, NOW, COVERED_SINCE);
    expect(slots).toHaveLength(1);
    expect(slots[0].kind).toBe("appointment");
    expect(slots[0].appointmentId).toBe("a1");
  });

  it("plans the appointment reminder even when the day already has a medication slot", () => {
    // Deliberately NOT suppressed here. Whether the second call is wanted depends on
    // whether the first actually happened, which only dispatch can know: gating on "a
    // medication slot exists" meant a parent whose 09:00 slot lapsed unrung got no call at
    // all that day and no appointment reminder either. dispatchDueSlots cancels it when a
    // call has already covered the day.
    const { slots } = planSlotsForDay([med({ time_of_day: "09:00:00" })], [appt()], TZ, NOW, COVERED_SINCE);
    expect(slots.map((s) => s.kind).sort()).toEqual(["appointment", "medication"]);
  });

  it("plans at most ONE appointment reminder a day, the earliest", () => {
    // Looping every appointment into its own slot rang an appointment-only parent three
    // times in a day. Every dial already carries appointments_today, so the first call
    // names all of them — which is what hasCoveredCallToday used to guarantee.
    const { slots } = planSlotsForDay(
      [],
      [
        appt({ id: "a-late", starts_at: new Date("2026-09-11T00:00:00Z").toISOString() }), // 17:00 PDT
        appt({ id: "a-early", starts_at: new Date("2026-09-10T18:00:00Z").toISOString() }), // 11:00 PDT
        appt({ id: "a-mid", starts_at: new Date("2026-09-10T21:00:00Z").toISOString() }), // 14:00 PDT
      ],
      TZ,
      NOW,
      COVERED_SINCE
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].appointmentId).toBe("a-early");
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
  it("starts at consent, so slots from before a mid-day consent are never reported missed", () => {
    // A parent who consents at 15:00 — via the test-call button the dashboard points at —
    // had that afternoon's tick re-plan the elapsed 08:00 and 12:00 slots, revive them from
    // the consent hold's cancellation, and expire each into its own "check-in was missed"
    // text. Different slots, different fingerprints, so nothing merged them.
    expect(
      coverageStartsAt({
        paused_until: null,
        resumed_at: null,
        first_call_after: null,
        consent_given_at: "2026-09-10T22:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
      }).toISOString()
    ).toBe("2026-09-10T22:00:00.000Z");
  });

  it("takes the latest of the four, so the most recent hold wins", () => {
    expect(
      coverageStartsAt({
        paused_until: "2026-09-05T00:00:00Z",
        resumed_at: "2026-09-08T00:00:00Z",
        first_call_after: "2026-09-06T00:00:00Z",
        consent_given_at: "2026-09-02T00:00:00Z",
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
        consent_given_at: null,
        created_at: "2026-09-01T00:00:00Z",
      }).toISOString()
    ).toBe("2026-09-10T18:00:00.000Z");
  });
});

describe("medsForNearestSlot", () => {
  const meds = [
    med({ id: "m1", name: "Morning", time_of_day: "08:00:00" }),
    med({ id: "m2", name: "Midday", time_of_day: "12:00:00" }),
    med({ id: "m3", name: "MiddayTwo", time_of_day: "12:00:00" }),
    med({ id: "m4", name: "Evening", time_of_day: "18:00:00" }),
  ];

  it("returns only the most recent due slot, not every dose since midnight", () => {
    // 13:00 PDT. medsDueNow is cumulative by design, so handing its whole result to a call
    // asks an elderly person about breakfast and lunch at once and reports each unconfirmed
    // one as missed. A scheduled call only ever carries one slot.
    const at = new Date("2026-09-10T20:00:00Z");
    expect(medsForNearestSlot(meds, TZ, at).map((m) => m.name).sort()).toEqual(["Midday", "MiddayTwo"]);
  });

  it("carries every medication sharing that slot's time", () => {
    const at = new Date("2026-09-10T20:00:00Z");
    expect(medsForNearestSlot(meds, TZ, at)).toHaveLength(2);
  });

  it("excludes a dose that isn't due yet", () => {
    // 09:00 PDT — the 18:00 pill must not be asked about, which was the original defect.
    const at = new Date("2026-09-10T16:00:00Z");
    expect(medsForNearestSlot(meds, TZ, at).map((m) => m.name)).toEqual(["Morning"]);
  });

  it("returns nothing before the first dose of the day", () => {
    const at = new Date("2026-09-10T14:00:00Z"); // 07:00 PDT
    expect(medsForNearestSlot(meds, TZ, at)).toEqual([]);
  });
});

describe("medsForSlot", () => {
  // 08:00 and 18:00 PDT on 2026-09-10.
  const morning = new Date("2026-09-10T15:00:00Z");
  const evening = new Date("2026-09-11T01:00:00Z");
  const meds = [
    med({ id: "m1", name: "Insulin", dose: "10 units", time_of_day: "08:00:00" }),
    med({ id: "m2", name: "Insulin", dose: "20 units", time_of_day: "18:00:00" }),
  ];

  it("returns one row per name even when a medication is taken twice a day", () => {
    // A plain filter matched both rows against one slot's ["Insulin"] snapshot, and Rosie
    // was told to ask about "Insulin and Insulin".
    expect(medsForSlot(meds, ["Insulin"], morning, TZ)).toHaveLength(1);
  });

  it("returns the row for THIS slot's time, not the first one with that name", () => {
    // find-by-name returned the 08:00 row for the evening slot, so Rosie would state the
    // morning dose on the evening call. Confusing became wrong.
    expect(medsForSlot(meds, ["Insulin"], evening, TZ)[0].dose).toBe("20 units");
    expect(medsForSlot(meds, ["Insulin"], morning, TZ)[0].dose).toBe("10 units");
  });

  it("falls back to the name when no medication matches that time any more", () => {
    // The snapshot predates an edit that moved the dose. The name is the best evidence left
    // of what the call was for, so the slot still names something rather than nothing.
    const moved = [med({ id: "m1", name: "Insulin", dose: "10 units", time_of_day: "09:30:00" })];
    expect(medsForSlot(moved, ["Insulin"], morning, TZ).map((m) => m.name)).toEqual(["Insulin"]);
  });

  it("drops a name whose medication no longer exists", () => {
    expect(medsForSlot([med({ name: "Kept" })], ["Kept", "Deleted"], morning, TZ).map((m: Medication) => m.name)).toEqual(["Kept"]);
  });
});

describe("medsForNearestSlot staleness", () => {
  it("returns nothing when the only dose is long past", () => {
    // A test call at 20:00 for a parent whose only dose is 08:00 asked about a twelve-hour-
    // old dose, and anything unconfirmed was reported to the family as "Not taken". A
    // scheduled call for that slot would have expired hours earlier.
    const meds = [med({ name: "Morning", time_of_day: "08:00:00" })];
    const at = new Date("2026-09-11T03:00:00Z"); // 20:00 PDT
    expect(medsForNearestSlot(meds, TZ, at)).toEqual([]);
  });

  it("still returns a dose inside the catch-up window (control)", () => {
    const meds = [med({ name: "Morning", time_of_day: "08:00:00" })];
    const at = new Date("2026-09-10T16:00:00Z"); // 09:00 PDT, one hour after the dose
    expect(medsForNearestSlot(meds, TZ, at).map((m) => m.name)).toEqual(["Morning"]);
  });
});
