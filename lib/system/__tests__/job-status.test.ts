import { describe, expect, it } from "vitest";

import { backupHealth, formatAge } from "@/lib/system/job-status";

describe("backup health (PRD §4.18: alert if the last backup is older than 48 hours)", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("is never when no backup has succeeded", () => {
    expect(backupHealth(null, now)).toMatchObject({ state: "never", lastOkAt: null, ageHours: null });
  });

  it("is ok up to and including 48 hours, stale after", () => {
    expect(backupHealth(hoursAgo(3), now).state).toBe("ok");
    expect(backupHealth(hoursAgo(48), now).state).toBe("ok");
    expect(backupHealth(hoursAgo(48.1), now).state).toBe("stale");
  });

  it("reports a newer failed attempt alongside an older good backup", () => {
    const h = backupHealth(hoursAgo(20), now, { at: hoursAgo(1), error: "pg_dump: connection refused" });
    expect(h.state).toBe("ok");
    expect(h.lastFailure).toEqual({ at: hoursAgo(1).toISOString(), error: "pg_dump: connection refused" });
  });

  it("formats ages for people", () => {
    expect(formatAge(0.5)).toBe("under an hour");
    expect(formatAge(1)).toBe("1 hour");
    expect(formatAge(47.9)).toBe("47 hours");
    expect(formatAge(72)).toBe("3 days");
  });
});
