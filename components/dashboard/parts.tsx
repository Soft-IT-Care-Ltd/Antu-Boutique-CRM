import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// P4.3 building blocks. Every figure on a dashboard is a link to the list
// it summarises (PRD §4.16) — these components make that the only way to
// put a number on the screen.

/** A headline figure: the whole tile is the link. An icon sits in a disc
 *  tinted with the tile's accent (set by TileGrid's position cycle). */
export function StatTile({ label, value, href, sub, icon: Icon, tone }: { label: string; value: ReactNode; href: string; sub?: ReactNode; icon?: LucideIcon; tone?: "danger" | "warning" }) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-3 text-card-foreground transition-colors hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-4.5 sm:py-4",
        tone === "danger" && "border-destructive/40",
      )}
    >
      <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        {Icon ? (
          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full text-foreground">
            <span className="absolute inset-0 rounded-full bg-(--tile-accent,var(--chart-1)) opacity-20" aria-hidden />
            <Icon className="relative size-4" />
          </span>
        ) : (
          <ChevronRight className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </span>
      <span className={cn("truncate text-xl leading-tight font-semibold tabular-nums sm:text-2xl", tone === "danger" && "text-destructive", tone === "warning" && "text-amber-600 dark:text-amber-500")}>{value}</span>
      {sub ? <span className="truncate text-xs text-muted-foreground">{sub}</span> : null}
    </Link>
  );
}

// Chart series order (violet, orange, teal, yellow, lime) — the only other
// place the accents appear is a KPI tile's icon disc.
const ACCENT_CYCLE =
  "[&>*:nth-child(5n+1)]:[--tile-accent:var(--chart-1)] [&>*:nth-child(5n+2)]:[--tile-accent:var(--chart-2)] [&>*:nth-child(5n+3)]:[--tile-accent:var(--chart-3)] [&>*:nth-child(5n+4)]:[--tile-accent:var(--chart-4)] [&>*:nth-child(5n+5)]:[--tile-accent:var(--chart-5)]";

export function TileGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-3 xl:grid-cols-6", ACCENT_CYCLE, className)}>{children}</div>;
}

export function SectionTitle({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A count per status (or stage) — each row is a link, with a bar for its share of the largest. */
export function CountBars({ rows, empty }: { rows: { key: string; label: string; count: number; href: string; tone?: "danger" }[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (empty && rows.every((r) => r.count === 0)) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-col">
      {rows.map((r) => (
        <li key={r.key}>
          <Link href={r.href} className="flex items-center gap-3 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
            <span className="w-32 shrink-0 truncate sm:w-40">{r.label}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className={cn("block h-full rounded-full", r.tone === "danger" ? "bg-destructive" : "bg-[var(--viz-online)]")} style={{ width: `${(r.count / max) * 100}%` }} />
            </span>
            <span className={cn("w-10 shrink-0 text-right font-semibold tabular-nums", r.count === 0 && "font-normal text-muted-foreground")}>{r.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One line of the alerts list: an icon, what's wrong, the count as the link. */
export function AlertRow({ icon: Icon, label, count, detail, href, active }: { icon: LucideIcon; label: string; count: ReactNode; detail?: ReactNode; href: string; active: boolean }) {
  return (
    <li>
      <Link href={href} className="flex items-start gap-3 rounded-md p-2 hover:bg-muted">
        <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{label}</span>
          {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
        </span>
        <span className={cn("shrink-0 text-right font-semibold tabular-nums", active ? "text-destructive" : "text-muted-foreground")}>{count}</span>
      </Link>
    </li>
  );
}
