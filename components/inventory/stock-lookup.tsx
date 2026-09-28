"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PackageSearch, ScanBarcode, Warehouse } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { looksLikeBanglaKeyboard } from "@/lib/barcode/scan";
import { uploadUrl } from "@/lib/catalog/types";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { StockLookupItem } from "@/lib/inventory/types";

/**
 * CORRECTIONS.md item 2 — "where is this dress?". One box: a handheld
 * scanner types the tag's SKU and Enter (exact match, shown alone); a
 * person types a name, code or SKU (type-ahead). Every location's figure,
 * plus in transit, reserved and available — built for a phone.
 */
export function StockLookup() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ term: string; exact: boolean; items: StockLookupItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (term: string) => {
    const t = term.trim();
    if (!t) return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<{ exact: boolean; items: StockLookupItem[] }>(`/api/inventory/lookup?q=${encodeURIComponent(t)}`);
      if (mine === seq.current) setResult({ term: t, ...data });
    } catch (err) {
      if (mine === seq.current) setError(err instanceof ApiError ? err.message : "Couldn't look that up — try again.");
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  // Type-ahead for people; a scanner's Enter runs at once (below).
  useEffect(() => {
    const t = query.trim();
    if (t.length < 2) return;
    const timer = setTimeout(() => void run(t), 250);
    return () => clearTimeout(timer);
  }, [query, run]);

  const bangla = looksLikeBanglaKeyboard(query);

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
          // A scanner sends the next tag straight after — clear and stay in the box.
          inputRef.current?.select();
        }}
        className="relative"
      >
        <ScanBarcode className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Scan a tag, or type a SKU or product name"
          className="h-12 pl-10 text-base"
          aria-label="Scan or search stock"
          autoComplete="off"
          autoCapitalize="characters"
          enterKeyHint="search"
        />
        {busy ? <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" /> : null}
      </form>
      {bangla ? <p className="text-sm text-amber-700 dark:text-amber-400">The keyboard is on Bangla — switch it to English so the scanner&apos;s code reads right.</p> : null}
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      {result === null ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
          <PackageSearch className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Find any dress, at every location</p>
          <p className="max-w-sm text-sm text-muted-foreground">Scan its price tag or type its name. You&apos;ll see how many are at each location, on the way, reserved for online orders and free to sell.</p>
        </div>
      ) : result.items.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">Nothing matches “{result.term}”.</div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {result.items.map((item) => (
            <li key={item.variantId} className="flex flex-col gap-3 rounded-xl border p-3">
              <div className="flex gap-3">
                <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                  {item.thumbPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={uploadUrl(item.thumbPath)} alt="" className="size-full object-cover" />
                  ) : (
                    <PackageSearch className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.productName}</p>
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: item.colorHex }} />
                    <b className="text-foreground">{item.sizeName}</b> · {item.colorName}
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{item.sku}</span>
                    {item.price ? <span>· {formatBDT(item.price)}</span> : null}
                    {item.isPackaging ? <Badge variant="outline">Packaging</Badge> : null}
                    {!item.isActive ? <Badge variant="outline">Switched off</Badge> : null}
                  </p>
                </div>
              </div>

              <ul className="flex flex-col divide-y rounded-lg border text-sm">
                {item.locations.map((loc) => (
                  <li key={loc.locationId} className="flex items-center justify-between gap-2 px-2.5 py-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Warehouse className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{loc.name}</span>
                      {loc.isPackingHub ? <Badge variant="outline">Packing hub</Badge> : null}
                      {loc.hasPos ? <Badge variant="outline">POS</Badge> : null}
                    </span>
                    <span className={`shrink-0 text-base font-semibold tabular-nums ${loc.qty < 0 ? "text-destructive" : loc.qty === 0 ? "text-muted-foreground" : ""}`}>{loc.qty}</span>
                  </li>
                ))}
              </ul>

              <dl className="grid grid-cols-4 gap-1 text-center text-xs">
                {[
                  ["In transit", item.inTransit],
                  ["Total", item.total],
                  ["Reserved", item.reserved],
                  ["Available", item.available],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-md bg-muted/60 px-1 py-1.5">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className={`text-sm font-semibold tabular-nums ${label === "Available" && Number(value) <= 0 ? "text-destructive" : ""}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
