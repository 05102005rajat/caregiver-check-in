import { describe, expect, it } from "vitest";
import {
  appointmentsToday,
  formatLocalTime,
  medsAtLocalTime,
  medsDueNow,
  scheduledForToday,
} from "./schedule";
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
