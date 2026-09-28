import { shiftDay, shortDay, type DayRange } from "@/lib/dashboard/links";
import { describeDateRange, resolveDateRange, type DateRangeValue } from "@/lib/date-range";
import { dhakaMonth, dhakaToday } from "@/lib/targets/month";

// The Dhaka days every dashboard works on. Client- and server-safe.

export const CHART_DAYS = 30;

export type DashboardRanges = {
  today: string;
  month: string;
  monthStart: string;
  /** First day of the 30-day charts (today included). */
  chartFrom: string;
  /** The earlier of the month's start and the chart's — one fetch covers both. */
  windowFrom: string;
  todayRange: DayRange;
  mtdRange: DayRange;
  chartRange: DayRange;
};

export function dashboardRanges(now = new Date()): DashboardRanges {
  const today = dhakaToday(now);
  const month = dhakaMonth(now);
  const monthStart = `${month}-01`;
  const chartFrom = shiftDay(today, -(CHART_DAYS - 1));
  return {
    today,
    month,
    monthStart,
    chartFrom,
    windowFrom: monthStart < chartFrom ? monthStart : chartFrom,
    todayRange: { from: today, to: today },
    mtdRange: { from: monthStart, to: today },
    chartRange: { from: chartFrom, to: today },
  };
}

// CORRECTIONS.md item 16 — the dashboard's date filter. Period figures
// (orders, value, collected, due, expenses, profit) follow it; live
// figures (the funnel, queues, alerts) and the monthly targets don't.

export type DashboardPeriod = {
  value: DateRangeValue;
  /** "This Month", "Last 7 days", "1 Sep – 15 Sep 2026". */
  label: string;
  range: DayRange;
  /** The daily charts: the period itself, widened to 30 days when it's shorter than a week, or its last 92 days when it's longer. */
  chartRange: DayRange;
  chartLabel: string;
};

const MIN_CHART_DAYS = 7;
const SHORT_CHART_DAYS = 30;
const MAX_CHART_DAYS = 92;

const daysIn = (r: DayRange) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;

/** `allTimeFrom` is where All Time starts (the first order or expense). */
export function dashboardPeriod(value: DateRangeValue, allTimeFrom: string | undefined, now = new Date()): DashboardPeriod {
  const today = dhakaToday(now);
  const resolved = resolveDateRange(value, now);
  const to = resolved.to && resolved.to < today ? resolved.to : today;
  let from = resolved.from ?? allTimeFrom ?? `${dhakaMonth(now)}-01`;
  if (from > to) from = to;
  const range = { from, to };
  const length = daysIn(range);
  let chartRange = range;
  let chartLabel = describeDateRange(value);
  if (length < MIN_CHART_DAYS) {
    chartRange = { from: shiftDay(to, -(SHORT_CHART_DAYS - 1)), to };
    chartLabel = to === today ? `Last ${SHORT_CHART_DAYS} days` : `${SHORT_CHART_DAYS} days to ${shortDay(to)}`;
  } else if (length > MAX_CHART_DAYS) {
    chartRange = { from: shiftDay(to, -(MAX_CHART_DAYS - 1)), to };
    chartLabel = `Last ${MAX_CHART_DAYS} days of ${describeDateRange(value)}`;
  }
  return { value, label: describeDateRange(value), range, chartRange, chartLabel };
}
