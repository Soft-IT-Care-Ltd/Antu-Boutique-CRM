"use client";

import { Layers, Minus, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fromPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import type { PricedCartLine } from "@/lib/pos/cart";

/** P3.3 — an outfit set in the POS cart: its sizes/colours are chosen, its price and qty edited like a line. */
export type CartSetLine = {
  key: string;
  setId: string;
  name: string;
  parts: { label: string; sku: string; qtyPerSet: number }[];
  choices: { productId: string; variantId: string }[];
  /** Sets the chosen combination can fill. */
  available: number;
  qty: number;
  unitPrice: string;
  lineDiscount: string;
};

export function PosSetLines({
  lines,
  priced,
  onChange,
  onRemove,
  onRechoose,
}: {
  lines: CartSetLine[];
  priced: Map<string, PricedCartLine> | null;
  onChange: (key: string, patch: Partial<CartSetLine>) => void;
  onRemove: (key: string) => void;
  onRechoose: (line: CartSetLine) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {lines.map((line) => {
        const p = priced?.get(line.key);
        const short = line.qty > line.available;
        return (
          <li key={line.key} className="flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-medium">
                  <Layers className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{line.name}</span>
                </p>
                <ul className="text-sm text-muted-foreground">
                  {line.parts.map((part) => (
                    <li key={part.sku}>
                      ↳ {part.qtyPerSet > 1 ? `${part.qtyPerSet} × ` : ""}
                      {part.label}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-semibold tabular-nums">{p ? formatBDT(fromPaisa(p.netPaisa)) : "—"}</p>
                {p && p.discountPaisa > 0 ? <p className="text-xs text-muted-foreground tabular-nums">− {formatBDT(fromPaisa(p.discountPaisa))} off</p> : null}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.name}`}>
                <Button type="button" variant="outline" className="size-11" aria-label="One less" onClick={() => (line.qty > 1 ? onChange(line.key, { qty: line.qty - 1 }) : onRemove(line.key))}>
                  <Minus />
                </Button>
                <Input
                  className="h-11 w-14 text-center text-base tabular-nums"
                  inputMode="numeric"
                  aria-label="Quantity"
                  value={String(line.qty)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ""));
                    if (Number.isFinite(n) && n >= 1 && n <= 999) onChange(line.key, { qty: n });
                  }}
                />
                <Button type="button" variant="outline" className="size-11" aria-label="One more" onClick={() => onChange(line.key, { qty: Math.min(999, line.qty + 1) })}>
                  <Plus />
                </Button>
              </div>
              <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                Set price
                <Input className="h-11 w-24 text-base tabular-nums" inputMode="decimal" value={line.unitPrice} onChange={(e) => onChange(line.key, { unitPrice: e.target.value })} />
              </label>
              <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                Discount
                <Input className="h-11 w-24 text-base tabular-nums" inputMode="decimal" placeholder="0" value={line.lineDiscount} onChange={(e) => onChange(line.key, { lineDiscount: e.target.value })} />
              </label>
              <Button type="button" variant="ghost" className="size-11" aria-label="Change sizes and colours" onClick={() => onRechoose(line)}>
                <Pencil />
              </Button>
              <Button type="button" variant="ghost" className="ml-auto size-11 text-destructive" aria-label={`Remove ${line.name}`} onClick={() => onRemove(line.key)}>
                <Trash2 />
              </Button>
            </div>
            {short ? (
              <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                The system shows {Math.max(0, line.available)} set(s) in these sizes — you can still sell it if the pieces are in hand; you&apos;ll be asked to confirm.
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
