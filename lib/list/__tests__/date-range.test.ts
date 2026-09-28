import { describe, expect, it } from "vitest";

import { dashboardPeriod } from "@/lib/dashboard/ranges";
import { dateRangeFromDays, dateRangeFromParams, dateRangeQuery, dateRangeToParams, resolveDateRange, ALL_TIME_FROM } from "@/lib/date-range";

// CORRECTIONS.md item 16 — Dhaka days, not the server's.
// 2026-09-30 20:30 UTC is already 1 October in Dhaka (UTC+6).
const LATE_UTC = new Date("2026-09-30T20:30:00Z");
const MID = new Date("2026-09-15T06:00:00Z");

describe("resolveDateRange", () => {
  it("resolves every preset against Dhaka's calendar", () => {
    expect(resolveDateRange({ preset: "today" }, LATE_UTC)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(resolveDateRange({ preset: "yesterday" }, LATE_UTC)).toEqual({ from: "2026-09-30", to: "2026-09-30" });
    expect(resolveDateRange({ preset: "last7" }, LATE_UTC)).toEqual({ from: "2026-09-25", to: "2026-10-01" });
    expect(resolveDateRange({ preset: "this_month" }, LATE_UTC)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(resolveDateRange({ preset: "last_month" }, LATE_UTC)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolveDateRange({ preset: "all" }, LATE_UTC)).toEqual({});
  });

  it("handles a year boundary and a short February", () => {
    const jan = new Date("2027-01-10T00:00:00Z");
    expect(resolveDateRange({ preset: "last_month" }, jan)).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    const mar = new Date("2027-03-02T00:00:00Z");
    expect(resolveDateRange({ preset: "last_month" }, mar)).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  it("keeps a custom range, swapping reversed ends and dropping junk", () => {
    expect(resolveDateRange({ preset: "custom", from: "2026-09-10", to: "2026-09-01" })).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(resolveDateRange({ preset: "custom", from: "nonsense", to: "2026-09-01" })).toEqual({ from: undefined, to: "2026-09-01" });
  });
});

describe("URL round trip", () => {
  it("reads a preset, a custom range and a bare from/to link", () => {
    expect(dateRangeFromParams({ range: "last7" })).toEqual({ preset: "last7" });
    expect(dateRangeFromParams({ range: "custom", from: "2026-09-01", to: "2026-09-05" })).toEqual({ preset: "custom", from: "2026-09-01", to: "2026-09-05" });
    expect(dateRangeFromParams({})).toEqual({ preset: "this_month" });
    expect(dateRangeFromParams({}, "all")).toEqual({ preset: "all" });
    expect(dateRangeFromParams({ range: "bogus" }, "all")).toEqual({ preset: "all" });
    // A dashboard link with this month's days lands on the preset, not "custom".
    const month = resolveDateRange({ preset: "this_month" });
    expect(dateRangeFromParams({ from: month.from, to: month.to })).toEqual({ preset: "this_month" });
  });

  it("writes what it reads", () => {
    for (const v of [{ preset: "today" as const }, { preset: "all" as const }, { preset: "custom" as const, from: "2026-09-01", to: "2026-09-05" }]) {
      expect(dateRangeFromParams(dateRangeToParams(v))).toEqual(v);
    }
  });

  it("matches days to a preset, else a custom range", () => {
    expect(dateRangeFromDays("2026-09-15", "2026-09-15", MID)).toEqual({ preset: "today" });
    expect(dateRangeFromDays("2026-09-01", "2026-09-15", MID)).toEqual({ preset: "this_month" });
    expect(dateRangeFromDays("2026-09-02", "2026-09-15", MID)).toEqual({ preset: "custom", from: "2026-09-02", to: "2026-09-15" });
    expect(dateRangeFromDays(undefined, undefined, MID)).toEqual({ preset: "all" });
  });
});

describe("dateRangeQuery", () => {
  it("sends only the ends a range has, or both when bounded", () => {
    expect(dateRangeQuery({ preset: "all" })).toEqual({});
    expect(dateRangeQuery({ preset: "all" }, { bounded: true, now: MID })).toEqual({ from: ALL_TIME_FROM, to: "2026-09-15" });
    expect(dateRangeQuery({ preset: "yesterday" }, { now: MID })).toEqual({ from: "2026-09-14", to: "2026-09-14" });
  });
});

describe("dashboardPeriod", () => {
  it("charts the period, widening a short one to 30 days and trimming a long one to 92", () => {
    const month = dashboardPeriod({ preset: "this_month" }, undefined, MID);
    expect(month.range).toEqual({ from: "2026-09-01", to: "2026-09-15" });
    expect(month.chartRange).toEqual(month.range);

    const today = dashboardPeriod({ preset: "today" }, undefined, MID);
    expect(today.range).toEqual({ from: "2026-09-15", to: "2026-09-15" });
    expect(today.chartRange).toEqual({ from: "2026-08-17", to: "2026-09-15" });

    const all = dashboardPeriod({ preset: "all" }, "2025-01-01", MID);
    expect(all.range).toEqual({ from: "2025-01-01", to: "2026-09-15" });
    expect(all.chartRange).toEqual({ from: "2026-06-16", to: "2026-09-15" });
  });

  it("never runs past today", () => {
    const future = dashboardPeriod({ preset: "custom", from: "2026-09-10", to: "2026-12-31" }, undefined, MID);
    expect(future.range).toEqual({ from: "2026-09-10", to: "2026-09-15" });
  });
});
