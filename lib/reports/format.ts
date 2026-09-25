import { formatBDT } from "@/lib/money";
import type { CellFormat, ReportCell } from "@/lib/reports/types";

// How a report cell reads on screen and in the PDF. Client- and server-safe.

const INT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatCell(value: ReportCell, format: CellFormat = "text"): string {
  if (value === null || value === "") return format === "text" ? "" : "—";
  switch (format) {
    case "money":
      return formatBDT(value);
    case "percent":
      return `${(Number(value) * 100).toFixed(1)}%`;
    case "int":
      return INT.format(Number(value));
    case "day":
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? DAY.format(new Date(`${value}T00:00:00Z`)) : String(value);
    default:
      return String(value);
  }
}

export const isNegative = (value: ReportCell) => value !== null && value !== "" && Number(value) < 0;

export function formatPeriod(period: { fromDay: string; toDay: string } | null): string {
  if (!period) return "As of now";
  const a = formatCell(period.fromDay, "day");
  const b = formatCell(period.toDay, "day");
  return a === b ? a : `${a} – ${b}`;
}
