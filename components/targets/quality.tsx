import { CircleAlert, CircleCheck } from "lucide-react";

import { QUALITY_WARNING_RATE } from "@/lib/targets/constants";
import type { StatsView } from "@/lib/targets/types";
import { cn } from "@/lib/utils";

export const pct = (ratio: number | null, digits = 0) => (ratio === null ? "—" : `${(ratio * 100).toFixed(digits)}%`);

/**
 * PRD §4.13 "delivered-vs-returned quality shown alongside": the share of
 * finished orders that stuck, with the counts behind it. Below the warning
 * rate it says so with an icon, not just a colour.
 */
export function QualityCell({ stats, className }: { stats: StatsView; className?: string }) {
  const rate = stats.deliveredRate;
  const warn = rate !== null && rate < QUALITY_WARNING_RATE;
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className={cn("inline-flex items-center gap-1 text-sm font-medium tabular-nums", warn ? "text-destructive" : "")}>
        {rate === null ? null : warn ? <CircleAlert className="size-3.5" aria-label="Many returns" /> : <CircleCheck className="size-3.5 text-muted-foreground" aria-hidden />}
        {rate === null ? "No outcome yet" : `${pct(rate)} delivered`}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {stats.delivered} delivered · {stats.returned} returned{stats.inProgress ? ` · ${stats.inProgress} on the way` : ""}
      </span>
    </div>
  );
}

/** A single-series 0–1 bar; the figure is always printed beside it. Overflow past the goal fills the bar. */
export function Meter({ value, className }: { value: number | null; className?: string }) {
  const width = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={cn("h-2 w-full rounded-full bg-muted", className)} aria-hidden>
      <div className="h-2 rounded-full bg-primary" style={{ width: `${width}%`, minWidth: width > 0 ? 4 : 0 }} />
    </div>
  );
}
