import { shiftDay, type DayRange } from "@/lib/dashboard/links";
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
