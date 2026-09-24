"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { setsAvailable } from "@/lib/sets/pricing";
import type { SetComponentView, SetDetail } from "@/lib/sets/types";

/** A set with a size/colour chosen for each component — what the order form and POS keep in their cart. */
export type ChosenSet = {
  setId: string;
  name: string;
  price: string;
  choices: { productId: string; variantId: string }[];
  /** One line per component: "Kurti · M / Maroon", with units per set. */
  parts: { productId: string; label: string; sku: string; qtyPerSet: number }[];
  /** Sets this exact combination can fill right now. */
  available: number;
  /** Units per set of each chosen variant (for stock checks against other cart lines). */
  perSet: { variantId: string; qty: number }[];
};

// P3.3 — adding an outfit set: one size/colour per component product, like
// Gift Valy's choice slots. Shows what each size/colour has in stock and how
// many sets the chosen combination can fill (min over components of
// available ÷ units per set). Selling prices and stock only.
export function SetChooserDialog({
  setId,
  initial,
  onClose,
  onChoose,
}: {
  setId: string;
  /** Pre-select these (editing a set already in the cart). */
  initial?: { productId: string; variantId: string }[];
  onClose: () => void;
  onChoose: (chosen: ChosenSet) => void;
}) {
  const [set, setSet] = useState<SetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries((initial ?? []).map((c) => [c.productId, c.variantId])));

  useEffect(() => {
    let live = true;
    fetchJson<{ set: SetDetail }>(`/api/catalog/sets/${setId}`)
      .then(({ set: s }) => {
        if (!live) return;
        setSet(s);
        // Where a component has one size/colour in stock (or only one at all), pick it.
        setPicked((prev) => {
          const next = { ...prev };
          for (const c of s.components) {
            if (next[c.productId]) continue;
            const inStock = c.variants.filter((v) => v.available >= c.qty);
            if (c.variants.length === 1) next[c.productId] = c.variants[0].id;
            else if (inStock.length === 1) next[c.productId] = inStock[0].id;
          }
          return next;
        });
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load the set."));
    return () => {
      live = false;
    };
  }, [setId]);

  const variantOf = (c: SetComponentView) => c.variants.find((v) => v.id === picked[c.productId]) ?? null;
  const complete = set !== null && set.components.every((c) => variantOf(c));
  const available = set && complete ? setsAvailable(set.components.map((c) => ({ available: variantOf(c)!.available, qtyPerSet: c.qty }))) : 0;

  function choose() {
    if (!set || !complete) return;
    onChoose({
      setId: set.id,
      name: set.name,
      price: set.price,
      choices: set.components.map((c) => ({ productId: c.productId, variantId: picked[c.productId] })),
      parts: set.components.map((c) => {
        const v = variantOf(c)!;
        return { productId: c.productId, label: `${c.productName} · ${v.sizeName} / ${v.colorName}`, sku: v.sku, qtyPerSet: c.qty };
      }),
      available,
      perSet: set.components.map((c) => ({ variantId: picked[c.productId], qty: c.qty })),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{set ? set.name : "Outfit set"}</DialogTitle>
          <DialogDescription>{set ? `${formatBDT(set.price)} a set — pick the size and colour of each piece.` : "Loading…"}</DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!set && !error ? <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /> : null}

        {set ? (
          <div className="flex flex-col gap-4">
            {set.components.map((c) => (
              <div key={c.productId} className="flex flex-col gap-1.5">
                <Label className="text-sm">
                  {c.qty > 1 ? `${c.qty} × ` : ""}
                  {c.productName} <span className="font-mono text-xs font-normal text-muted-foreground">{c.productCode}</span>
                </Label>
                {c.variants.length === 0 ? (
                  <p className="text-xs text-destructive">No size or colour of this product is for sale.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {c.variants.map((v) => {
                      const selected = picked[c.productId] === v.id;
                      const short = v.available < c.qty;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setPicked((prev) => ({ ...prev, [c.productId]: v.id }))}
                          className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-sm ${selected ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:bg-muted"} ${short ? "opacity-60" : ""}`}
                        >
                          <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: v.colorHex }} />
                          <span>
                            {v.sizeName} / {v.colorName}
                            <span className={`block text-xs ${short ? "text-destructive" : "text-muted-foreground"}`}>{v.available > 0 ? `${v.available} available` : "out of stock"}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {set.packaging.length > 0 ? <p className="text-xs text-muted-foreground">Packed with: {set.packaging.map((p) => `${p.qty} × ${p.label}`).join(", ")}</p> : null}
            <p className={`text-sm ${complete && available === 0 ? "text-destructive" : "text-muted-foreground"}`}>
              {!complete ? "Pick every piece to see how many sets are in stock." : available > 0 ? `${available} set${available === 1 ? "" : "s"} available in this combination.` : "This combination is out of stock."}
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={choose} disabled={!complete}>
            Add set
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
