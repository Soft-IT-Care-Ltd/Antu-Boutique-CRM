"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OrderItemPicker } from "@/components/orders/order-item-picker";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { ProductDetail } from "@/lib/catalog/types";
import { formatBDT } from "@/lib/money";

export type Replacement = {
  variantId: string;
  productId: string;
  /** "Product — Size / Colour" */
  label: string;
  /** "Size / Colour" */
  option: string;
  price: string;
  available: number;
};

// PRD §4.11 exchange: what the customer gets instead. Usually the same
// garment in another size or colour, picked from its own variants; any
// other product can be searched for. Selling prices and stock only.
export function ReplacementPicker({
  productId,
  currentVariantId,
  value,
  onChange,
}: {
  productId: string;
  currentVariantId: string;
  value: Replacement | null;
  onChange: (value: Replacement | null) => void;
}) {
  const [siblings, setSiblings] = useState<Replacement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetchJson<{ product: ProductDetail }>(`/api/catalog/products/${productId}`)
      .then(({ product }) =>
        setSiblings(
          product.variants
            .filter((v) => v.id !== currentVariantId && v.isActive)
            .map((v) => ({
              variantId: v.id,
              productId: product.id,
              label: `${product.name} — ${v.size.name} / ${v.color.name}`,
              option: `${v.size.name} / ${v.color.name}`,
              price: v.priceOverride ?? product.basePrice,
              available: v.available,
            })),
        ),
      )
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the other sizes and colours."));
  }, [productId, currentVariantId]);

  const isSibling = value ? siblings?.some((s) => s.variantId === value.variantId) : false;
  const placeholder = siblings === null ? "Loading sizes…" : siblings.length === 0 ? "No other size or colour" : "Pick another size / colour";

  return (
    <div className="flex flex-col gap-1.5">
      {!searching ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={isSibling ? value!.variantId : ""}
            onValueChange={(id) => onChange(siblings?.find((s) => s.variantId === id) ?? null)}
            disabled={!siblings || siblings.length === 0}
          >
            <SelectTrigger className="h-9 min-w-56 flex-1">
              <SelectValue placeholder={placeholder}>
                {(id: string) => {
                  const s = siblings?.find((x) => x.variantId === id);
                  return s ? `${s.option} · ${s.available} available` : placeholder;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(siblings ?? []).map((s) => (
                <SelectItem key={s.variantId} value={s.variantId} disabled={s.available < 1}>
                  {s.option} · {s.available > 0 ? `${s.available} available` : "out of stock"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSearching(true)}>
            Another product…
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <OrderItemPicker
            onPick={(v) => {
              onChange({ variantId: v.variantId, productId: "", label: `${v.productName} — ${v.sizeName} / ${v.colorName}`, option: `${v.sizeName} / ${v.colorName}`, price: v.effectivePrice, available: v.available });
              setSearching(false);
            }}
          />
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setSearching(false)}>
            Back to sizes and colours
          </Button>
        </div>
      )}
      {value && !isSibling ? (
        <p className="text-xs">
          Picked: <b>{value.label}</b> · {formatBDT(value.price)} · {value.available} available{" "}
          <button type="button" className="text-muted-foreground underline" onClick={() => onChange(null)}>
            clear
          </button>
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
