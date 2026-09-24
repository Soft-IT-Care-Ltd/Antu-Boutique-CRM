"use client";

import { Minus, Plus, ShoppingBasket, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBDT } from "@/lib/money";
import type { PricedCartLine } from "@/lib/pos/cart";
import { fromPaisa } from "@/lib/inventory/costing";

export type CartLine = {
  key: string;
  variantId: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  available: number;
  listPrice: string;
  qty: number;
  unitPrice: string;
  lineDiscount: string;
  overrideReason: string;
};

export function PosCart({
  lines,
  priced,
  selectedVariantId,
  canSellOutOfStock,
  onSelect,
  onChange,
  onRemove,
  hasOtherLines = false,
}: {
  /** P3.3 — outfit sets are in the cart (listed separately): no empty state. */
  hasOtherLines?: boolean;
  lines: CartLine[];
  priced: Map<string, PricedCartLine> | null;
  selectedVariantId: string | null;
  canSellOutOfStock: boolean;
  onSelect: (variantId: string) => void;
  onChange: (key: string, patch: Partial<CartLine>) => void;
  onRemove: (key: string) => void;
}) {
  if (lines.length === 0) {
    if (hasOtherLines) return null;
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
        <ShoppingBasket className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">The cart is empty</p>
        <p className="max-w-xs text-sm text-muted-foreground">Scan a price tag, or type a product name or SKU above and press Enter.</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {lines.map((line) => {
        const p = priced?.get(line.key);
        const short = line.qty > line.available;
        const selected = line.variantId === selectedVariantId;
        return (
          <li key={line.key} className={`flex flex-col gap-2 p-3 ${selected ? "bg-muted/50" : ""}`} onClick={() => onSelect(line.variantId)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{line.productName}</p>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: line.colorHex }} />
                  <b className="text-foreground">{line.sizeName}</b> · {line.colorName}
                  <span className="hidden font-mono text-xs sm:inline">· {line.sku}</span>
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-semibold tabular-nums">{p ? formatBDT(fromPaisa(p.netPaisa)) : "—"}</p>
                {p && p.discountPaisa > 0 ? <p className="text-xs text-muted-foreground tabular-nums">− {formatBDT(fromPaisa(p.discountPaisa))} off</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.productName}`}>
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
                Price
                <Input className="h-11 w-24 text-base tabular-nums" inputMode="decimal" value={line.unitPrice} onChange={(e) => onChange(line.key, { unitPrice: e.target.value })} />
              </label>
              <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                Discount
                <Input className="h-11 w-24 text-base tabular-nums" inputMode="decimal" placeholder="0" value={line.lineDiscount} onChange={(e) => onChange(line.key, { lineDiscount: e.target.value })} />
              </label>
              <Button type="button" variant="ghost" className="ml-auto size-11 text-destructive" aria-label={`Remove ${line.productName}`} onClick={() => onRemove(line.key)}>
                <Trash2 />
              </Button>
            </div>

            {short ? (
              canSellOutOfStock ? (
                <Input
                  className="h-10"
                  placeholder={`Only ${Math.max(0, line.available)} available — reason to sell anyway`}
                  value={line.overrideReason}
                  onChange={(e) => onChange(line.key, { overrideReason: e.target.value })}
                />
              ) : (
                <p className="text-sm text-destructive">Only {Math.max(0, line.available)} available — the sale will be refused. Ask a Manager to check the stock.</p>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
