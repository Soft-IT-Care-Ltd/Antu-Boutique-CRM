"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History, MoreHorizontal, PackageX, Search, SlidersHorizontal, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StockChangeDialog, type StockChangeMode } from "@/components/inventory/stock-change-dialog";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { StockStatusFilter, VariantStockStatus } from "@/lib/inventory/constants";
import type { StockReportRow, StockReportTotals } from "@/lib/inventory/types";
import { formatBDT, formatLakh } from "@/lib/money";

const PAGE_SIZE = 25;

const STATUS_BADGE: Record<VariantStockStatus, { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  OK: { label: "In stock", variant: "secondary" },
  LOW: { label: "Low", variant: "outline" },
  OUT: { label: "Out", variant: "destructive" },
};

const STATUS_FILTER_LABELS: Record<StockStatusFilter, string> = {
  all: "All stock levels",
  in: "In stock",
  low: "Low stock",
  out: "Out of stock",
};

type Props = {
  categories: { id: string; name: string }[];
  canViewCatalog: boolean;
  hasCostAccess: boolean;
  canAdjust: boolean;
  canViewLedger: boolean;
};

export function StockReport({ categories, canViewCatalog, hasCostAccess, canAdjust, canViewLedger }: Props) {
  const [items, setItems] = useState<StockReportRow[] | null>(null);
  const [totals, setTotals] = useState<StockReportTotals | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [status, setStatus] = useState<StockStatusFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<{ mode: StockChangeMode; row: StockReportRow } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), status });
    if (debouncedQ) params.set("q", debouncedQ);
    if (categoryId !== "all") params.set("categoryId", categoryId);

    fetchJson<{ items: StockReportRow[]; total: number; totals: StockReportTotals }>(`/api/inventory/stock?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setTotals(data.totals);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load stock."));
  }, [debouncedQ, categoryId, status, page, reloadKey]);

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showActions = canAdjust || canViewLedger;

  return (
    <div className="flex flex-col gap-4">
      <div className={`grid grid-cols-2 gap-2 ${hasCostAccess ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
        <SummaryTile label="Variants" value={totals ? formatLakh(totals.variants) : null} />
        <SummaryTile label="On hand" value={totals ? formatLakh(totals.onHand) : null} />
        <SummaryTile label="Reserved" value={totals ? formatLakh(totals.reserved) : null} />
        <SummaryTile label="Available" value={totals ? formatLakh(totals.available) : null} />
        {hasCostAccess ? (
          <SummaryTile
            label="Value at cost"
            value={totals?.valueAtCost !== undefined ? formatBDT(totals.valueAtCost) : null}
            className="col-span-2 md:col-span-1"
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search product, code or SKU..." value={q} onChange={(e) => updateFilter(setQ, e.target.value)} className="pl-8" />
        </div>
        <Select value={categoryId} onValueChange={(v) => updateFilter(setCategoryId, v as string)}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Category">
              {(value: string) => (value === "all" ? "All categories" : (categories.find((c) => c.id === value)?.name ?? "Category"))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => updateFilter(setStatus, v as StockStatusFilter)}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Stock level">{(value: StockStatusFilter) => STATUS_FILTER_LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_FILTER_LABELS) as StockStatusFilter[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_FILTER_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <PackageX className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No variants match</p>
          <p className="text-sm text-muted-foreground">Try a different search or stock level.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Reserved</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead>Status</TableHead>
              {hasCostAccess ? <TableHead className="text-right">Avg cost</TableHead> : null}
              {hasCostAccess ? <TableHead className="text-right">Value at cost</TableHead> : null}
              {showActions ? <TableHead className="w-10" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.variantId} className={row.isActive ? undefined : "opacity-60"}>
                <TableCell>
                  {canViewCatalog ? (
                    <Link href={`/catalog/products/${row.productId}`} className="font-medium hover:underline">
                      {row.productName}
                    </Link>
                  ) : (
                    <span className="font-medium">{row.productName}</span>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {row.productCode}
                    {row.categoryName ? ` · ${row.categoryName}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: row.colorHex }} />
                    <span className="font-semibold">
                      {row.sizeName} / {row.colorName}
                    </span>
                    {row.isActive ? null : <Badge variant="outline">Inactive</Badge>}
                  </span>
                  <div className="font-mono text-xs text-muted-foreground">{row.sku}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.stockQty}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{row.reservedQty}</TableCell>
                <TableCell className={`text-right font-semibold tabular-nums ${row.available <= 0 ? "text-destructive" : ""}`}>{row.available}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[row.status].variant}>{STATUS_BADGE[row.status].label}</Badge>
                  {row.status !== "OK" ? <div className="pt-0.5 text-xs text-muted-foreground">alert at ≤ {row.threshold}</div> : null}
                </TableCell>
                {hasCostAccess ? (
                  <TableCell className="text-right text-muted-foreground tabular-nums">{row.weightedAvgCost ? formatBDT(row.weightedAvgCost) : "—"}</TableCell>
                ) : null}
                {hasCostAccess ? (
                  <TableCell className="text-right tabular-nums">{row.valueAtCost ? formatBDT(row.valueAtCost) : "—"}</TableCell>
                ) : null}
                {showActions ? (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.sku}`} />}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuGroup>
                          {canViewLedger ? (
                            <DropdownMenuItem render={<Link href={`/inventory/movements?variantId=${row.variantId}`} />}>
                              <History />
                              View ledger
                            </DropdownMenuItem>
                          ) : null}
                          {canAdjust ? (
                            <DropdownMenuItem onClick={() => setDialog({ mode: "adjust", row })}>
                              <SlidersHorizontal />
                              Adjust stock
                            </DropdownMenuItem>
                          ) : null}
                          {canAdjust ? (
                            <DropdownMenuItem variant="destructive" disabled={row.stockQty <= 0} onClick={() => setDialog({ mode: "write-off", row })}>
                              <Trash2 />
                              Write off damage
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {total} variants
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}

      {canAdjust ? (
        <StockChangeDialog
          mode={dialog?.mode ?? "adjust"}
          row={dialog?.row ?? null}
          onOpenChange={(open) => !open && setDialog(null)}
          onDone={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}

function SummaryTile({ label, value, className }: { label: string; value: string | null; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardContent>
        <div className="text-xs text-muted-foreground">{label}</div>
        {value === null ? <Skeleton className="mt-1 h-6 w-16" /> : <div className="text-lg font-semibold tabular-nums">{value}</div>}
      </CardContent>
    </Card>
  );
}
