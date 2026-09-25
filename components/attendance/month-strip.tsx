import { formatDay, MARK_CLASS } from "@/components/attendance/attendance-badges";
import { DAY_MARK_CODES, DAY_MARK_LABELS } from "@/lib/attendance/constants";
import type { AttendanceDay, AttendanceTotals } from "@/lib/attendance/types";
import { cn } from "@/lib/utils";

/** One person's month as a row of lettered day cells, with the legend. */
export function MonthStrip({ days }: { days: AttendanceDay[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-7 gap-1 sm:grid-cols-[repeat(16,minmax(0,1fr))]">
        {days.map((d) => (
          <div
            key={d.day}
            title={`${formatDay(d.day, true)} — ${DAY_MARK_LABELS[d.mark]}${d.noCheckOut ? " (no check-out)" : ""}`}
            className={cn("flex h-10 flex-col items-center justify-center rounded-md border text-[11px] leading-tight", MARK_CLASS[d.mark], d.mark === "NONE" && "border-dashed")}
          >
            <span className="text-[10px] opacity-70">{Number(d.day.slice(8))}</span>
            <span className="font-semibold">{DAY_MARK_CODES[d.mark] || "·"}</span>
          </div>
        ))}
      </div>
      <MarkLegend />
    </div>
  );
}

export function MarkLegend() {
  const marks = ["PRESENT", "LATE", "HALF_DAY", "ABSENT", "LEAVE", "WEEKLY_OFF", "HOLIDAY"] as const;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {marks.map((m) => (
        <span key={m} className="inline-flex items-center gap-1">
          <span className={cn("rounded px-1 font-semibold", MARK_CLASS[m])}>{DAY_MARK_CODES[m]}</span>
          {DAY_MARK_LABELS[m]}
        </span>
      ))}
    </p>
  );
}

export function TotalsRow({ totals }: { totals: AttendanceTotals }) {
  const items: [string, number, string?][] = [
    ["Working days", totals.workingDays],
    ["Present", totals.present],
    ["Late", totals.late, totals.lateMinutes ? `${totals.lateMinutes} min in all` : undefined],
    ["Half day", totals.halfDay],
    ["Absent", totals.absent],
    ["Leave", totals.leave],
  ];
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {items.map(([label, value, sub]) => (
        <div key={label}>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{value}</p>
          {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
        </div>
      ))}
    </div>
  );
}
