"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Minus, PackageOpen, Plus, Printer, Search, Tags, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_LABEL_STOCK_ID,
  findLabelStock,
  fitBarcode,
  LABEL_STOCKS,
  renderTagHtml,
  ROLL_PRINTER_DPIS,
  stockDpi,
  TAG_CSS,
  type RollPrinterDpi,
} from "@/lib/catalog/price-tag-layout";
import { formatDhakaDate } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";

// The shape /api/catalog/price-tags/source returns (lib/catalog/price-tags.ts TagSourceItem).
export type TagSourceItem = {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  sizeName: string;
  colorName: string;
  price: string;
  onHand: number;
  suggestedCopies: number;
  barcodeSafe: boolean;
  locked: boolean;
};

type Row = TagSourceItem & { copies: number };

type PurchaseOption = { id: string; purchaseDate: string; invoiceNo: string | null; supplierName: string; lines: number; units: number };

const MAX_COPIES = 500;

/**
 * P3.1 price tags: pick what to tag (single variants, a whole product, or
 * everything a purchase received), how many of each, and the label stock.
 * The preview is the exact HTML the PDF is made from.
 */
export function PriceTagPrinter({ initialItems, initialSource }: { initialItems: TagSourceItem[]; initialSource: string | null }) {
  const [rows, setRows] = useState<Row[]>(() => initialItems.map((i) => ({ ...i, copies: i.suggestedCopies })));
  const [stockId, setStockId] = useState(DEFAULT_LABEL_STOCK_ID);
  const [rollDpi, setRollDpi] = useState<RollPrinterDpi>(203);
  const [startAt, setStartAt] = useState(1);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TagSourceItem[]>([]);
  const [purchases, setPurchases] = useState<PurchaseOption[]>([]);
  const [purchaseId, setPurchaseId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const payloadRef = useRef<HTMLInputElement>(null);

  const stock = findLabelStock(stockId)!;
  const dpi = stockDpi(stock, rollDpi);

  useEffect(() => {
    fetchJson<{ purchases: PurchaseOption[] }>("/api/catalog/price-tags/purchases")
      .then((d) => setPurchases(d.purchases))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const timer = setTimeout(() => {
      fetchJson<{ items: TagSourceItem[] }>(`/api/catalog/price-tags/source?q=${encodeURIComponent(term)}`)
        .then((d) => setResults(d.items))
        .catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  function addItems(items: TagSourceItem[], useSuggested: boolean) {
    setRows((prev) => {
      const next = [...prev];
      for (const item of items) {
        const copies = useSuggested ? item.suggestedCopies : 1;
        const at = next.findIndex((r) => r.variantId === item.variantId);
        if (at >= 0) next[at] = { ...next[at], copies: Math.min(MAX_COPIES, next[at].copies + copies) };
        else next.push({ ...item, copies });
      }
      return next;
    });
  }

  async function loadPurchase(id: string) {
    setPurchaseId(id);
    if (!id) return;
    setError(null);
    try {
      const d = await fetchJson<{ items: TagSourceItem[] }>(`/api/catalog/price-tags/source?purchaseId=${encodeURIComponent(id)}`);
      addItems(d.items, true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load that purchase.");
    }
  }

  async function addWholeProduct(productId: string) {
    try {
      const d = await fetchJson<{ items: TagSourceItem[] }>(`/api/catalog/price-tags/source?productId=${encodeURIComponent(productId)}`);
      addItems(d.items, true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load that product.");
    }
  }

  const fits = useMemo(() => new Map(rows.map((r) => [r.variantId, r.barcodeSafe ? fitBarcode(r.sku, stock, dpi).quality : "unsafe"])), [rows, stock, dpi]);
  const totalTags = rows.reduce((a, r) => a + r.copies, 0);
  const blocked = rows.filter((r) => r.copies > 0 && (fits.get(r.variantId) === "too-long" || fits.get(r.variantId) === "unsafe"));
  const willLock = rows.filter((r) => r.copies > 0 && !r.locked).length;
  const sheets = stock.kind === "SHEET" && totalTags > 0 ? Math.ceil((totalTags + startAt - 1) / (stock.cols * stock.rows)) : 0;
  const previewRow = rows.find((r) => r.copies > 0 && r.barcodeSafe) ?? rows[0];

  function print() {
    setError(null);
    if (!payloadRef.current || !formRef.current) return;
    payloadRef.current.value = JSON.stringify({ items: rows.filter((r) => r.copies > 0).map((r) => ({ variantId: r.variantId, copies: r.copies })), stockId, dpi: rollDpi, startAt });
    // A real form post into a new tab: the PDF opens on every browser
    // (iPad Safari included) with no pop-up blocker and no blob URLs.
    formRef.current.submit();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="relative flex flex-col gap-1.5">
            <Label htmlFor="tag-search">Add a product or SKU</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="tag-search" className="h-11 pl-8" placeholder="Name, code or SKU…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
            </div>
            {query.trim().length >= 2 && results.length > 0 ? (
              <div className="absolute top-full z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
                {results.map((r) => (
                  <div key={r.variantId} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                    <button type="button" className="min-h-10 min-w-0 flex-1 text-left" onClick={() => addItems([r], false)}>
                      <span className="block truncate text-sm font-medium">{r.productName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <b className="text-foreground">{r.sizeName}</b> · {r.colorName} · <span className="font-mono">{r.sku}</span> · {r.onHand} on hand
                      </span>
                    </button>
                    <Button type="button" variant="ghost" className="h-10 shrink-0 text-xs" onClick={() => void addWholeProduct(r.productId)}>
                      All sizes
                    </Button>
                  </div>
                ))}
                <button type="button" className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted" onClick={() => setResults([])}>
                  Close
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Everything received in a purchase</Label>
            <Select value={purchaseId} onValueChange={(v) => void loadPurchase((v as string) ?? "")}>
              <SelectTrigger className="h-11 w-full">
                <SelectValue placeholder="Pick a purchase">
                  {(v: string) => {
                    const p = purchases.find((x) => x.id === v);
                    return p ? `${formatDhakaDate(p.purchaseDate)} · ${p.supplierName}` : "Pick a purchase";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {purchases.length === 0 ? <SelectItem value="__none" disabled>No purchases yet</SelectItem> : null}
                {purchases.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {formatDhakaDate(p.purchaseDate)} · {p.supplierName}
                    {p.invoiceNo ? ` · ${p.invoiceNo}` : ""} · {p.units} pcs
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {initialSource ? <p className="text-sm text-muted-foreground">{initialSource}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-14 text-center">
            <PackageOpen className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No tags yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Search for a product, or pick a purchase to tag everything it brought in — one tag per piece.</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border">
            {rows.map((r) => {
              const fit = fits.get(r.variantId);
              return (
                <li key={r.variantId} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.productName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      <b className="text-foreground">{r.sizeName}</b> · {r.colorName} · <span className="font-mono text-xs">{r.sku}</span> · {formatBDT(r.price)}
                    </p>
                    {fit === "unsafe" ? (
                      <Badge variant="destructive" className="mt-1">SKU has characters a barcode can&apos;t carry — edit the SKU</Badge>
                    ) : fit === "too-long" ? (
                      <Badge variant="destructive" className="mt-1">SKU too long for this label — pick a wider label or an A4 sheet</Badge>
                    ) : r.locked ? (
                      <Badge variant="outline" className="mt-1">SKU locked — tags already printed</Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="outline" className="size-10" aria-label="One fewer tag" onClick={() => setRows((p) => p.map((x) => (x.variantId === r.variantId ? { ...x, copies: Math.max(0, x.copies - 1) } : x)))}>
                      <Minus />
                    </Button>
                    <Input
                      className="h-10 w-16 text-center tabular-nums"
                      inputMode="numeric"
                      aria-label={`Tags for ${r.sku}`}
                      value={String(r.copies)}
                      onChange={(e) => {
                        const n = Math.min(MAX_COPIES, Number(e.target.value.replace(/\D/g, "")) || 0);
                        setRows((p) => p.map((x) => (x.variantId === r.variantId ? { ...x, copies: n } : x)));
                      }}
                    />
                    <Button type="button" variant="outline" className="size-10" aria-label="One more tag" onClick={() => setRows((p) => p.map((x) => (x.variantId === r.variantId ? { ...x, copies: Math.min(MAX_COPIES, x.copies + 1) } : x)))}>
                      <Plus />
                    </Button>
                    <Button type="button" variant="ghost" className="size-10 text-destructive" aria-label={`Remove ${r.sku}`} onClick={() => setRows((p) => p.filter((x) => x.variantId !== r.variantId))}>
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {rows.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={() => setRows((p) => p.map((x) => ({ ...x, copies: Math.max(0, x.onHand) })))}>
              One per piece on hand
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRows((p) => p.map((x) => ({ ...x, copies: 1 })))}>
              One of each
            </Button>
            <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => setRows([])}>
              Clear
            </Button>
          </div>
        ) : null}
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-col gap-1.5">
          <Label>Labels</Label>
          <Select value={stockId} onValueChange={(v) => setStockId((v as string) ?? DEFAULT_LABEL_STOCK_ID)}>
            <SelectTrigger className="h-11 w-full">
              <SelectValue>{(v: string) => findLabelStock(v)?.label ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LABEL_STOCKS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {stock.kind === "ROLL" ? (
          <div className="flex flex-col gap-1.5">
            <Label>Label printer resolution</Label>
            <div className="flex overflow-hidden rounded-lg border" role="group" aria-label="Printer resolution">
              {ROLL_PRINTER_DPIS.map((d) => (
                <button key={d} type="button" aria-pressed={rollDpi === d} className={`h-10 flex-1 text-sm ${rollDpi === d ? "bg-primary text-primary-foreground" : "bg-background"}`} onClick={() => setRollDpi(d)}>
                  {d} dpi
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Most shop label printers are 203 dpi. Print at 100% / “actual size” — never “fit to page”.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tag-start">Start at label no.</Label>
            <Input id="tag-start" className="h-11" inputMode="numeric" value={String(startAt)} onChange={(e) => setStartAt(Math.min(stock.cols * stock.rows, Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1)))} />
            <p className="text-xs text-muted-foreground">Skip labels already used on a half-used sheet. Print at 100% (no scaling), no margins.</p>
          </div>
        )}

        {previewRow ? (
          <div className="flex flex-col gap-1.5">
            <Label>Preview</Label>
            <div className="flex justify-center overflow-hidden rounded-lg border bg-muted/40 p-4">
              <style>{TAG_CSS}</style>
              <div style={{ zoom: 1.6 }}>
                <div className="tag" style={{ position: "relative", width: `${stock.width}mm`, height: `${stock.height}mm`, boxShadow: "0 0 0 1px rgb(0 0 0 / 0.15)" }} dangerouslySetInnerHTML={{ __html: renderTagHtml(previewRow, stock, dpi) }} />
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tags</span>
            <span className="font-semibold tabular-nums">{totalTags}</span>
          </div>
          {stock.kind === "SHEET" ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">A4 sheets</span>
              <span className="font-semibold tabular-nums">{sheets}</span>
            </div>
          ) : null}
        </div>
        {blocked.length > 0 ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {blocked.length} item{blocked.length === 1 ? " can't" : "s can't"} be printed on these labels — see the red notes.
          </p>
        ) : willLock > 0 ? (
          <p className="text-xs text-muted-foreground">Printing locks the SKU of {willLock} variant{willLock === 1 ? "" : "s"} — once a tag carries a SKU it can&apos;t change.</p>
        ) : null}
        <Button type="button" className="h-12 text-base" disabled={totalTags === 0 || blocked.length > 0} onClick={print}>
          <Printer />
          Print {totalTags} tag{totalTags === 1 ? "" : "s"}
        </Button>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Tags className="size-3.5" /> The barcode is the SKU — the POS scan box reads it back exactly.
        </p>
        <form ref={formRef} method="post" action="/api/catalog/price-tags" target="_blank" className="hidden">
          <input ref={payloadRef} type="hidden" name="payload" />
        </form>
      </aside>
    </div>
  );
}
