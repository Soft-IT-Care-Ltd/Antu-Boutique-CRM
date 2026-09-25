import { formatBDT } from "@/lib/money";
import { perDayNeeded } from "@/lib/targets/stats";
import type { Progress } from "@/lib/targets/types";

import { Meter, pct, QualityCell } from "@/components/targets/quality";

const ARC_R = 80;
const ARC_LEN = Math.PI * ARC_R;

/**
 * PRD §4.13 live progress gauge — "Tk 1,42,000 of Tk 2,00,000 — 71%, 9 days
 * left". A half-ring for the headline measure (value if there's a value
 * target, else the order count), a bar for the other, and the quality line.
 */
export function TargetGauge({ progress, daysLeft, compact = false }: { progress: Progress; daysLeft: number; compact?: boolean }) {
  const { target, stats } = progress;
  const byValue = Boolean(target?.orderValue);
  const ratio = byValue ? progress.valueProgress : progress.countProgress;
  const filled = Math.max(0, Math.min(1, ratio ?? 0));

  const achieved = byValue ? formatBDT(stats.salesValue) : `${stats.orderCount} orders`;
  const goal = byValue ? formatBDT(target!.orderValue!) : target?.orderCount ? `${target.orderCount} orders` : null;
  const needed = byValue
    ? perDayNeeded(Number(stats.salesValue), Number(target!.orderValue), daysLeft)
    : perDayNeeded(stats.orderCount, target?.orderCount, daysLeft);
  const daysText = daysLeft === 0 ? "month over" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;

  if (!target) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-2xl font-semibold tabular-nums">{formatBDT(stats.salesValue)}</p>
        <p className="text-sm text-muted-foreground">
          {stats.orderCount} orders this month · no target set · {daysText}
        </p>
        {!compact ? <QualityCell stats={stats} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-6">
      <svg viewBox="0 0 200 112" className="w-44 shrink-0" role="img" aria-label={`${pct(ratio)} of target`}>
        <path d={`M 20 100 A ${ARC_R} ${ARC_R} 0 0 1 180 100`} fill="none" className="stroke-muted" strokeWidth="14" strokeLinecap="round" />
        {filled > 0 ? (
          <path
            d={`M 20 100 A ${ARC_R} ${ARC_R} 0 0 1 180 100`}
            fill="none"
            className="stroke-primary"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={`${filled * ARC_LEN} ${ARC_LEN}`}
          />
        ) : null}
        <text x="100" y="92" textAnchor="middle" className="fill-foreground text-[28px] font-semibold tabular-nums">
          {pct(ratio)}
        </text>
      </svg>
      <div className="flex w-full flex-col gap-2">
        <p className="text-base">
          <span className="font-semibold tabular-nums">{achieved}</span> <span className="text-muted-foreground">of</span> <span className="tabular-nums">{goal}</span>
          <span className="text-muted-foreground">
            {" "}
            — {pct(ratio)}, {daysText}
          </span>
        </p>
        {needed !== null && needed > 0 ? (
          <p className="text-sm text-muted-foreground">{byValue ? `${formatBDT(needed)} a day` : `${needed} order${needed === 1 ? "" : "s"} a day`} to reach it.</p>
        ) : ratio !== null && ratio >= 1 ? (
          <p className="text-sm font-medium">Target reached.</p>
        ) : null}
        {byValue && target.orderCount ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="w-28 shrink-0 text-muted-foreground">
              {stats.orderCount} / {target.orderCount} orders
            </span>
            <Meter value={progress.countProgress} />
            <span className="w-10 shrink-0 text-right tabular-nums">{pct(progress.countProgress)}</span>
          </div>
        ) : null}
        {!compact ? <QualityCell stats={stats} /> : null}
      </div>
    </div>
  );
}
