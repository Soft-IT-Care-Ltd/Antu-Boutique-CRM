"use client";

import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBDT } from "@/lib/money";
import { BDT_DENOMINATIONS, denominationTotal, type Denominations } from "@/lib/pos/constants";

export type CountState = { mode: "NOTES" | "TOTAL"; notes: Denominations; total: string };

export const EMPTY_COUNT: CountState = { mode: "NOTES", notes: {}, total: "" };

/** The counted amount, and the breakdown to store when counted note by note. */
export function countValue(c: CountState): { amount: number | null; denominations: Denominations | null } {
  // Nothing counted yet is "no count", not a count of ৳0 — an empty drawer is
  // closed by typing 0 as the total.
  if (c.mode === "NOTES") return Object.values(c.notes).some((n) => (n ?? 0) > 0) ? { amount: denominationTotal(c.notes), denominations: c.notes } : { amount: null, denominations: null };
  const n = Number(c.total);
  return { amount: c.total.trim() === "" || !Number.isFinite(n) ? null : n, denominations: null };
}

/** Count the drawer note by note (big touch targets), or type the total. */
export function DenominationCounter({ value, onChange }: { value: CountState; onChange: (c: CountState) => void }) {
  const { amount } = countValue(value);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex overflow-hidden rounded-lg border text-sm" role="group" aria-label="How to count">
        {(["NOTES", "TOTAL"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={value.mode === mode}
            className={`h-10 flex-1 ${value.mode === mode ? "bg-primary text-primary-foreground" : "bg-background"}`}
            onClick={() => onChange({ ...value, mode })}
          >
            {mode === "NOTES" ? "Count notes & coins" : "Type the total"}
          </button>
        ))}
      </div>

      {value.mode === "NOTES" ? (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {BDT_DENOMINATIONS.map((d) => {
            const key = `${d}` as const;
            const n = value.notes[key] ?? 0;
            const set = (next: number) => onChange({ ...value, notes: { ...value.notes, [key]: Math.max(0, Math.min(100_000, next)) } });
            return (
              <div key={d} className="flex items-center gap-1.5">
                <span className="w-14 shrink-0 text-right text-sm font-medium tabular-nums">৳ {d}</span>
                <span className="text-muted-foreground">×</span>
                <Button type="button" variant="outline" className="size-10" aria-label={`One less ৳${d}`} onClick={() => set(n - 1)}>
                  <Minus />
                </Button>
                <Input
                  className="h-10 w-16 text-center tabular-nums"
                  inputMode="numeric"
                  aria-label={`Number of ৳${d}`}
                  value={n === 0 ? "" : String(n)}
                  placeholder="0"
                  onChange={(e) => set(Number(e.target.value.replace(/\D/g, "")) || 0)}
                />
                <Button type="button" variant="outline" className="size-10" aria-label={`One more ৳${d}`} onClick={() => set(n + 1)}>
                  <Plus />
                </Button>
                <span className="ml-auto text-sm text-muted-foreground tabular-nums">{n > 0 ? formatBDT(n * d) : ""}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <Input className="h-12 text-lg tabular-nums" inputMode="decimal" placeholder="Counted cash, ৳" aria-label="Counted cash" value={value.total} onChange={(e) => onChange({ ...value, total: e.target.value })} />
      )}

      <div className="flex items-baseline justify-between border-t pt-2">
        <span className="text-sm text-muted-foreground">Counted</span>
        <span className="text-xl font-semibold tabular-nums">{amount === null ? "—" : formatBDT(amount)}</span>
      </div>
    </div>
  );
}
