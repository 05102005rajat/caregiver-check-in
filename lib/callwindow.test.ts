import { describe, expect, it } from "vitest";
import { CALLING_HOURS_END, CALLING_HOURS_START, isWithinCallingHours, localHour } from "./callwindow";

// 2026-09-17 is PDT (UTC-7), so 00:00 UTC = 17:00 previous day in Los Angeles.
const at = (utc: string) => new Date(utc);
const LA = "America/Los_Angeles";
const NY = "America/New_York";

describe("isWithinCallingHours", () => {
  it("allows ordinary daytime hours", () => {
    expect(isWithinCallingHours(at("2026-09-17T16:00:00Z"), LA)).toBe(true); // 9am
    expect(isWithinCallingHours(at("2026-09-17T20:00:00Z"), LA)).toBe(true); // 1pm
    expect(isWithinCallingHours(at("2026-09-18T03:59:00Z"), LA)).toBe(true); // 8:59pm
  });

  it("refuses the middle of the night — the case that had no guard at all", () => {
    expect(isWithinCallingHours(at("2026-09-17T10:00:00Z"), LA)).toBe(false); // 3am
    expect(isWithinCallingHours(at("2026-09-17T08:00:00Z"), LA)).toBe(false); // 1am
    expect(isWithinCallingHours(at("2026-09-17T06:59:00Z"), LA)).toBe(false); // 11:59pm
  });

  it("refuses late evening, when a scheduler catching up would otherwise dial", () => {
    // A 9am slot retried after an all-day outage: this is the 8pm/11pm call.
    expect(isWithinCallingHours(at("2026-09-18T04:00:00Z"), LA)).toBe(false); // 9pm
    expect(isWithinCallingHours(at("2026-09-18T05:30:00Z"), LA)).toBe(false); // 10:30pm
  });

  it("is evaluated in the parent's timezone, not the server's", () => {
    // 2am in LA is 5am in New York — both outside the window, but for different reasons.
    const moment = at("2026-09-17T09:00:00Z");
    expect(localHour(moment, LA)).toBe(2);
    expect(localHour(moment, NY)).toBe(5);
    expect(isWithinCallingHours(moment, LA)).toBe(false);
    expect(isWithinCallingHours(moment, NY)).toBe(false);

    // 7am LA is 10am NY: too early on the west coast, fine on the east.
    const morning = at("2026-09-17T14:00:00Z");
    expect(isWithinCallingHours(morning, LA)).toBe(false);
    expect(isWithinCallingHours(morning, NY)).toBe(true);
  });

  it("treats the boundaries as inclusive start, exclusive end", () => {
    expect(localHour(at("2026-09-17T15:00:00Z"), LA)).toBe(CALLING_HOURS_START);
    expect(isWithinCallingHours(at("2026-09-17T15:00:00Z"), LA)).toBe(true); // 8:00am exactly
    expect(localHour(at("2026-09-18T04:00:00Z"), LA)).toBe(CALLING_HOURS_END);
    expect(isWithinCallingHours(at("2026-09-18T04:00:00Z"), LA)).toBe(false); // 9:00pm exactly
  });
});
