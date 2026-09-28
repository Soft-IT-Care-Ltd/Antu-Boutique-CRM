import { shiftDay } from "@/lib/dashboard/links";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { dhakaToday, shiftMonth } from "@/lib/targets/month";

// CORRECTIONS.md item 16 — the one date filter every list, report and the
// dashboard use. A value is a named preset (resolved against Dhaka's
// calendar at the moment it's read, so "Today" rolls over at Dhaka
// midnight) or a custom inclusive day range. Client- and server-safe:
// the filter component, the pages that read it from the URL and the APIs
// that receive the resolved days all go through these functions.

export const DATE_RANGE_PRESETS = ["today", "yesterday", "last7", "this_month", "last_month", "all", "custom"] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  this_month: "This Month",
  last_month: "Last Month",
  all: "All Time",
  custom: "Custom range",
};

export type DateRangeValue = { preset: DateRangePreset; from?: string; to?: string };

/** Inclusive Dhaka days; an open end means unbounded (All Time has neither). */
export type ResolvedDays = { from?: string; to?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function resolveDateRange(value: DateRangeValue, now = new Date()): ResolvedDays {
  const today = dhakaToday(now);
  const month = today.slice(0, 7);
  switch (value.preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = shiftDay(today, -1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: shiftDay(today, -6), to: today };
    case "this_month":
      return { from: `${month}-01`, to: today };
    case "last_month": {
      const last = shiftMonth(month, -1);
      return { from: `${last}-01`, to: shiftDay(`${month}-01`, -1) };
    }
    case "all":
      return {};
    case "custom": {
      const from = isDay(value.from) ? value.from : undefined;
      const to = isDay(value.to) ? value.to : undefined;
      return from && to && from > to ? { from: to, to: from } : { from, to };
    }
  }
}

/** The preset a from/to pair matches today, else a custom range — so a dashboard link lands on "This Month", not "Custom". */
export function dateRangeFromDays(from: string | undefined, to: string | undefined, now = new Date()): DateRangeValue {
  if (!from && !to) return { preset: "all" };
  for (const preset of DATE_RANGE_PRESETS) {
    if (preset === "custom" || preset === "all") continue;
    const r = resolveDateRange({ preset }, now);
    if (r.from === from && r.to === to) return { preset };
  }
  return { preset: "custom", from, to };
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams;
const read = (p: Params, k: string) => {
  const v = p instanceof URLSearchParams ? p.get(k) : p[k];
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
};

/**
 * The filter as a URL carries it: `range=<preset>`, plus `from`/`to` for a
 * custom range. A bare from/to (older links, dashboard links) is matched to
 * its preset. Anything unreadable falls back to `fallback`.
 */
export function dateRangeFromParams(params: Params, fallback: DateRangePreset = "this_month"): DateRangeValue {
  const range = read(params, "range");
  const from = read(params, "from");
  const to = read(params, "to");
  const days = { from: isDay(from) ? from : undefined, to: isDay(to) ? to : undefined };
  if (range === "custom") return days.from || days.to ? { preset: "custom", ...days } : { preset: fallback };
  if ((DATE_RANGE_PRESETS as readonly string[]).includes(range ?? "")) return { preset: range as DateRangePreset };
  if (days.from || days.to) return dateRangeFromDays(days.from, days.to);
  return { preset: fallback };
}

/** The URL params for a value (the inverse of dateRangeFromParams). */
export function dateRangeToParams(value: DateRangeValue): Record<string, string> {
  if (value.preset !== "custom") return { range: value.preset };
  const out: Record<string, string> = { range: "custom" };
  if (value.from) out.from = value.from;
  if (value.to) out.to = value.to;
  return out;
}

/**
 * Where "All Time" starts for a screen that needs both ends (a report
 * that otherwise defaults to this month) — safely before the first record
 * this ERP holds.
 */
export const ALL_TIME_FROM = "2020-01-01";

/**
 * The resolved days as the list APIs take them (`from`/`to`, both
 * optional). `bounded` fills an open end — for report APIs that read a
 * missing end as "this month".
 */
export function dateRangeQuery(value: DateRangeValue, opts: { bounded?: boolean; now?: Date } = {}): Record<string, string> {
  const now = opts.now ?? new Date();
  const r = resolveDateRange(value, now);
  if (opts.bounded) {
    r.from ??= ALL_TIME_FROM;
    r.to ??= dhakaToday(now);
  }
  const out: Record<string, string> = {};
  if (r.from) out.from = r.from;
  if (r.to) out.to = r.to;
  return out;
}

/** "This Month", "1 Sep – 15 Sep 2026", "From 1 Sep 2026". */
export function describeDateRange(value: DateRangeValue): string {
  if (value.preset !== "custom") return DATE_RANGE_LABELS[value.preset];
  const r = resolveDateRange(value);
  const fmt = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
  if (r.from && r.to) return r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`;
  if (r.from) return `From ${fmt(r.from)}`;
  if (r.to) return `Up to ${fmt(r.to)}`;
  return DATE_RANGE_LABELS.all;
}

/** Inclusive Dhaka days (either end optional) → a [gte, lt) instant range for a where clause. */
export function dhakaDaysRange(fromDay?: string, toDay?: string): { gte?: Date; lt?: Date } {
  return { ...(fromDay ? { gte: dhakaDayStartUtc(fromDay) } : {}), ...(toDay ? { lt: dhakaDayStartUtc(toDay, 1) } : {}) };
}
