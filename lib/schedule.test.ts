import { describe, expect, it } from "vitest";
import {
  reminderSlotFor,
  appointmentsToday,
  formatLocalTime,
  localDayBoundsUtc,
  medsAtLocalTime,
  medsDueNow,
  scheduledForToday,
} from "./schedule";
import { fromZonedTime } from "date-fns-tz";
import { isWithinCallingHours } from "./callwindow";
import type { Appointment, Medication } from "@/types/db";

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
    ...overrides,
  };
}

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "a1",
    parent_id: "p1",
    title: "Dentist",
    starts_at: new Date().toISOString(),
    location: null,
    notes: null,
    ...overrides,
  };
}

describe("medsDueNow", () => {
  it("includes a med exactly at now", () => {
    // 2026-09-10T16:00:00Z = 9:00am PDT
    const now = new Date("2026-09-10T16:00:00Z");
    const meds = [med({ time_of_day: "09:00:00" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(1);
  });

  it("excludes a med that hasn't happened yet", () => {
    const now = new Date("2026-09-10T16:00:00Z"); // 9:00am PDT
    const future = med({ time_of_day: "09:05:00" });
    expect(medsDueNow([future], "America/Los_Angeles", now)).toHaveLength(0);
  });

  it("still includes a med whose time passed hours ago (delayed/skipped cron tick recovery)", () => {
    // A med due at 9:00 must still show up as due even if the cron didn't run again
    // until well past its time — the old forward-looking 5-minute window would have
    // silently dropped this forever once nowMinutes moved past medMinutes + 5.
    const now = new Date("2026-09-10T18:30:00Z"); // 11:30am PDT, med was due at 9:00am
    const meds = [med({ time_of_day: "09:00:00" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(1);
  });

  it("excludes inactive medications even if the time matches", () => {
    const now = new Date("2026-09-10T16:00:00Z");
    const meds = [med({ time_of_day: "09:00:00", active: false })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(0);
  });

  it("handles a medication scheduled right at midnight", () => {
    // 2026-09-11T08:00:00Z = midnight PDT (UTC-7) on 2026-09-11
    const now = new Date("2026-09-11T07:00:00Z");
    const meds = [med({ time_of_day: "00:00:00" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(1);
  });

  it("handles a medication scheduled at 23:59", () => {
    const now = new Date("2026-09-11T06:59:00Z"); // 11:59pm PDT on 2026-09-10
    const meds = [med({ time_of_day: "23:59:00" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(1);
  });

  it("is timezone-independent of the host system's local timezone", () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const now = new Date("2026-09-10T16:00:00Z"); // 9:00am PDT regardless of host TZ
      const meds = [med({ time_of_day: "09:00:00" })];
      expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(1);
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it("excludes a med whose date range hasn't started yet", () => {
    const now = new Date("2026-09-10T16:00:00Z"); // 9am PDT on 2026-09-10
    const meds = [med({ time_of_day: "09:00:00", start_date: "2026-09-15" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(0);
  });

  it("excludes a med whose date range has already ended", () => {
    const now = new Date("2026-09-10T16:00:00Z"); // 9am PDT on 2026-09-10
    const meds = [med({ time_of_day: "09:00:00", end_date: "2026-09-05" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(0);
  });

  it("includes a med on the boundary days of its date range, inclusive", () => {
    const startDay = new Date("2026-09-10T16:00:00Z"); // 9am PDT on 2026-09-10
    const endDay = new Date("2026-09-12T16:00:00Z"); // 9am PDT on 2026-09-12
    const meds = [med({ time_of_day: "09:00:00", start_date: "2026-09-10", end_date: "2026-09-12" })];
    expect(medsDueNow(meds, "America/Los_Angeles", startDay)).toHaveLength(1);
    expect(medsDueNow(meds, "America/Los_Angeles", endDay)).toHaveLength(1);
  });

  it("excludes a med the day after its date range ends", () => {
    const now = new Date("2026-09-13T16:00:00Z"); // 9am PDT on 2026-09-13
    const meds = [med({ time_of_day: "09:00:00", start_date: "2026-09-10", end_date: "2026-09-12" })];
    expect(medsDueNow(meds, "America/Los_Angeles", now)).toHaveLength(0);
  });
});

describe("scheduledForToday", () => {
  it("produces the correct UTC instant for a local time", () => {
    const now = new Date("2026-09-10T15:00:00Z"); // 8am PDT
    const result = scheduledForToday("09:00", "America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-09-10T16:00:00.000Z");
  });

  it("is stable across a different system timezone", () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const now = new Date("2026-09-10T15:00:00Z");
      const result = scheduledForToday("09:00", "America/Los_Angeles", now);
      expect(result.toISOString()).toBe("2026-09-10T16:00:00.000Z");
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it("uses the post-transition offset on the DST spring-forward day (2026-03-08, PST->PDT)", () => {
    // Clocks jump 2:00am -> 3:00am local; a 9am med that day is UTC-7 (PDT), not UTC-8 (PST).
    const now = new Date("2026-03-08T15:00:00Z"); // 7am PDT, after the 2am transition
    const result = scheduledForToday("09:00", "America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-03-08T16:00:00.000Z"); // 9am PDT = 16:00 UTC
  });

  it("computes the correct target offset when `now` is BEFORE today's spring-forward transition but the target time is AFTER it", () => {
    // now = 1am PST (pre-transition); target 09:00 will be 9am PDT once the day's 2am
    // transition happens — the target's offset must not be borrowed from `now`'s offset.
    const now = new Date("2026-03-08T09:00:00Z"); // 1am PST
    const result = scheduledForToday("09:00", "America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-03-08T16:00:00.000Z"); // 9am PDT = 16:00 UTC
  });

  it("computes the correct target offset when `now` is AFTER today's spring-forward transition but the target time is a pre-transition hour", () => {
    // now = 5am PDT (post-transition); target 01:00 already happened earlier that day in PST.
    const now = new Date("2026-03-08T12:00:00Z"); // 5am PDT
    const result = scheduledForToday("01:00", "America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-03-08T09:00:00.000Z"); // 1am PST = 09:00 UTC
  });

  it("handles the fall-back transition (2026-11-01, PDT->PST) correctly on both sides", () => {
    const now = new Date("2026-11-01T08:00:00Z"); // 1am PDT, before the 2am fall-back
    const result = scheduledForToday("09:00", "America/Los_Angeles", now);
    expect(result.toISOString()).toBe("2026-11-01T17:00:00.000Z"); // 9am PST = 17:00 UTC
  });
});

describe("medsAtLocalTime", () => {
  it("matches medications whose time_of_day equals the local hour:minute of the given instant", () => {
    const scheduledFor = new Date("2026-09-10T16:00:00Z"); // 9:00am PDT
    const meds = [med({ time_of_day: "09:00:00" }), med({ time_of_day: "20:00:00" })];
    const result = medsAtLocalTime(meds, scheduledFor, "America/Los_Angeles");
    expect(result).toHaveLength(1);
    expect(result[0].time_of_day).toBe("09:00:00");
  });
});

describe("formatLocalTime", () => {
  it("formats midnight and noon correctly", () => {
    expect(formatLocalTime(new Date("2026-09-11T07:00:00Z"), "America/Los_Angeles")).toBe("12:00am");
    expect(formatLocalTime(new Date("2026-09-10T19:00:00Z"), "America/Los_Angeles")).toBe("12:00pm");
  });

  it("formats a normal afternoon time", () => {
    expect(formatLocalTime(new Date("2026-09-10T16:03:00Z"), "America/Los_Angeles")).toBe("9:03am");
  });
});

describe("appointmentsToday", () => {
  it("includes an appointment on the same local day and excludes one on a different day", () => {
    const now = new Date("2026-09-10T18:00:00Z"); // 11am PDT on 2026-09-10
    const today = appt({ starts_at: new Date("2026-09-10T20:00:00Z").toISOString() });
    const tomorrow = appt({ starts_at: new Date("2026-09-11T20:00:00Z").toISOString() });
    const result = appointmentsToday([today, tomorrow], "America/Los_Angeles", now);
    expect(result).toEqual([today]);
  });
});

describe("reminderSlotFor", () => {
  it("is an hour before the appointment when that hour is callable", () => {
    const apptAt = new Date("2026-09-10T22:00:00Z"); // 15:00 PDT
    const a = appt({ starts_at: apptAt.toISOString() });
    expect(reminderSlotFor(a, "America/Los_Angeles")?.toISOString()).toBe("2026-09-10T21:00:00.000Z");
  });

  // starts_at — unlike medications.time_of_day — is not constrained by lib/validation.ts,
  // because a 7am hospital appointment is a real thing to enter. A flat "minus 60 minutes"
  // produced reminders at hours every dial path refuses: the slot was created, the dial was
  // refused, and nothing retried or reported it. These are the cases that used to be
  // guaranteed dead ends.
  it("moves a pre-dawn reminder to when the calling window opens", () => {
    const apptAt = new Date("2026-09-10T15:30:00Z"); // 08:30 PDT => 07:30 reminder
    const a = appt({ starts_at: apptAt.toISOString() });
    const slot = reminderSlotFor(a, "America/Los_Angeles");
    // 08:00 PDT, not 07:30 — still 30 minutes of notice, and actually dialable.
    expect(slot?.toISOString()).toBe("2026-09-10T15:00:00.000Z");
    expect(isWithinCallingHours(slot!, "America/Los_Angeles")).toBe(true);
  });

  it("drops a reminder that could only land after the appointment has already started", () => {
    // 07:00 PDT appointment: the reminder would be 6am, the earliest we may ring is 8am,
    // and by then the appointment has begun. Nothing useful left to say.
    const a = appt({ starts_at: new Date("2026-09-10T14:00:00Z").toISOString() });
    expect(reminderSlotFor(a, "America/Los_Angeles")).toBeNull();
  });

  it("drops a late-evening reminder rather than ringing outside the window", () => {
    // 22:30 PDT appointment => 21:30 reminder, past the 21:00 cutoff.
    const a = appt({ starts_at: new Date("2026-09-11T05:30:00Z").toISOString() });
    expect(reminderSlotFor(a, "America/Los_Angeles")).toBeNull();
  });

  it("never returns a reminder outside calling hours, for any appointment hour of the day", () => {
    // The property the cases above are examples of. Without it, a future change to the
    // clamp could reintroduce a dead-end slot at some hour nobody wrote a case for.
    const timezone = "America/Los_Angeles";
    for (let hour = 0; hour < 24; hour += 1) {
      const startsAt = fromZonedTime(`2026-09-10T${String(hour).padStart(2, "0")}:30:00`, timezone);
      const slot = reminderSlotFor(appt({ starts_at: startsAt.toISOString() }), timezone);
      if (slot) expect(isWithinCallingHours(slot, timezone)).toBe(true);
    }
  });
});

describe("localDayBoundsUtc", () => {
  it("returns the correct UTC instants for local midnight-to-midnight", () => {
    // 11am PDT on 2026-09-10 = 18:00 UTC. Local day is 2026-09-10 00:00 to 23:59:59.999 PDT.
    const now = new Date("2026-09-10T18:00:00Z");
    const { startUtc, endUtc } = localDayBoundsUtc("America/Los_Angeles", now);
    expect(startUtc.toISOString()).toBe("2026-09-10T07:00:00.000Z"); // midnight PDT = 7am UTC
    expect(endUtc.toISOString()).toBe("2026-09-11T06:59:59.999Z"); // 11:59:59.999pm PDT
  });

  it("a call scheduled just before local midnight falls within the same day's bounds, not the next", () => {
    const now = new Date("2026-09-10T18:00:00Z");
    const { endUtc } = localDayBoundsUtc("America/Los_Angeles", now);
    const justBeforeMidnight = new Date("2026-09-11T06:59:00Z"); // 11:59pm PDT on 2026-09-10
    expect(justBeforeMidnight.getTime()).toBeLessThanOrEqual(endUtc.getTime());
  });

  it("is timezone-independent of the host system's local timezone", () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const now = new Date("2026-09-10T18:00:00Z");
      const { startUtc } = localDayBoundsUtc("America/Los_Angeles", now);
      expect(startUtc.toISOString()).toBe("2026-09-10T07:00:00.000Z");
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});
