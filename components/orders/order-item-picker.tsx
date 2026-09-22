"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { ProductSearchResult, ProductSearchVariant } from "@/lib/orders/types";

export type PickedVariant = {
  variantId: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  available: number;
  effectivePrice: string;
  weightedAvgCost?: string;
};

// PRD §4.6 section 2: "Product search by name or SKU -> pick variant (size
// + colour)". Outfit sets aren't searchable here yet — they don't exist in
// the schema until P3.3 (see the comment on the search route itself).
export function OrderItemPicker({ onPick }: { onPick: (variant: PickedVariant) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim().length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      fetchJson<{ products: ProductSearchResult[] }>(`/api/catalog/products/search?q=${encodeURIComponent(query.trim())}`)
        .then((data) => {
          setResults(data.products);
          setOpen(true);
          setError(null);
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Search failed"))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function pick(product: ProductSearchResult, variant: ProductSearchVariant) {
    onPick({
      variantId: variant.id,
      productName: product.name,
      sku: variant.sku,
      sizeName: variant.sizeName,
      colorName: variant.colorName,
      colorHex: variant.colorHex,
      available: variant.available,
      effectivePrice: variant.effectivePrice,
      weightedAvgCost: variant.weightedAvgCost,
    });
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search product by name or SKU..."
          className="pl-8"
        />
        {searching ? <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" /> : null}
      </div>

      {error ? <p className="pt-1 text-xs text-destructive">{error}</p> : null}

      {open && results.length > 0 ? (
        <div className="absolute z-20 mt-1 max-h-80 w-full min-w-md overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
          {results.map((product) => (
            <div key={product.id} className="p-1.5">
              <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
                {product.name} <span className="font-mono">({product.code})</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {product.variants.length === 0 ? (
                  <p className="px-1.5 py-1 text-xs text-muted-foreground">No active variants</p>
                ) : (
                  product.variants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      onClick={() => pick(product, variant)}
                      className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: variant.colorHex }} />
                        {variant.sizeName} / {variant.colorName}
                        <span className="font-mono text-xs text-muted-foreground">{variant.sku}</span>
                      </span>
                      <span className="flex items-center gap-2 text-xs">
                        <span className={variant.available <= 0 ? "text-destructive" : "text-muted-foreground"}>
                          {variant.available} available
                        </span>
                        <Plus className="size-3.5" />
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {open && !searching && query.trim().length >= 2 && results.length === 0 ? (
        <div className="absolute z-20 mt-1 w-full rounded-lg border bg-popover p-3 text-center text-sm text-muted-foreground shadow-md">
          No matching products
        </div>
      ) : null}
    </div>
  );
}
