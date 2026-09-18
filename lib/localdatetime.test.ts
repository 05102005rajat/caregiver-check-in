import { describe, expect, it } from "vitest";
import { instantToLocalInput, localInputToInstant } from "./localdatetime";

describe("localInputToInstant", () => {
  it("resolves a wall-clock string in the parent's zone, not the server's", () => {
    // The bug this exists to prevent: under TZ=UTC (Vercel), `new Date("2026-09-20T09:00")`
    // yields 09:00Z — 2am in Los Angeles — and the reminder call fires in the middle of
    // the night.
    expect(localInputToInstant("2026-09-20T09:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-09-20T16:00:00.000Z"
    );
    expect(localInputToInstant("2026-09-20T09:00", "America/New_York").toISOString()).toBe(
      "2026-09-20T13:00:00.000Z"
    );
  });

  it("applies the right offset either side of a DST transition", () => {
    // US DST ends 2026-11-01. Same wall-clock time, different UTC offset (PDT vs PST).
    expect(localInputToInstant("2026-10-30T09:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-10-30T16:00:00.000Z"
    );
    expect(localInputToInstant("2026-11-05T09:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-11-05T17:00:00.000Z"
    );
  });
});

describe("round-trip", () => {
  it("shows back exactly what was entered, in every supported zone", () => {
    const entered = "2026-09-20T09:00";
    for (const tz of [
      "America/Los_Angeles",
      "America/Denver",
      "America/Chicago",
      "America/New_York",
      "America/Anchorage",
      "Pacific/Honolulu",
    ]) {
      const stored = localInputToInstant(entered, tz).toISOString();
      // Without this, re-opening /setup displayed the UTC time and the next save wrote
      // that wrong time back — the form silently corrupting its own data.
      expect(instantToLocalInput(stored, tz)).toBe(entered);
    }
  });
});
