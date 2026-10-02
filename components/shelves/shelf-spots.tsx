import type { ShelfSpotsValue } from "@/lib/shelves/constants";
import { cn } from "@/lib/utils";

// C4b — CORRECTIONS.md item 20A: "the shelf shows everywhere someone needs
// to find a dress". One line of chips — fullest shelf first, then what
// isn't on a shelf yet. Server- and client-safe.

export type { ShelfSpotsValue };

export function ShelfSpots({ value, className, prefix }: { value: ShelfSpotsValue; className?: string; prefix?: string }) {
  if (value.shelves.length === 0 && value.unassigned <= 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1 text-xs", className)}>
      {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
      {value.shelves.map((s) => (
        <span key={s.code} className="rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono font-semibold">
          {s.code}
          {s.qty > 1 ? <span className="font-normal text-muted-foreground"> ×{s.qty}</span> : null}
        </span>
      ))}
      {value.unassigned > 0 ? (
        <span className="rounded border border-dashed border-amber-500/60 px-1.5 py-0.5 text-amber-800 dark:text-amber-300">
          Unassigned {value.unassigned}
          {value.notOnShelf > 0 ? <span> · {value.notOnShelf} not on its shelf</span> : null}
        </span>
      ) : null}
    </span>
  );
}
