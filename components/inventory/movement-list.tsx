"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { History, Search, X } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import {
  formatDhakaDateTime,
  STOCK_MOVEMENT_LABELS,
  STOCK_MOVEMENT_TYPES,
  STOCK_REFERENCE_LABELS,
  type StockMovementTypeValue,
} from "@/lib/inventory/constants";
import type { StockMovementRow } from "@/lib/inventory/types";
import type { LocationOption } from "@/lib/locations/constants";
import { formatBDT } from "@/lib/money";

type Props = {
  hasCostAccess: boolean;
  initialVariant: { id: string; sku: string } | null;
  /** C3 — every location, to filter the ledger by one. */
  locations: LocationOption[];
  initialLocationId?: string;
  initialQ?: string;
};

export function MovementList({ hasCostAccess, initialVariant, locations, initialLocationId = "all", initialQ = "" }: Props) {
  const [items, setItems] = useState<StockMovementRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const pager = usePager("movements");
  const { page, pageSize, setPage } = pager;
  const [q, setQ] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  const [locationId, setLocationId] = useState(initialLocationId);
  const [type, setType] = useState<"all" | StockMovementTypeValue>("all");
  const [range, setRange] = useState<DateRangeValue>({ preset: "all" });
  const [variant, setVariant] = useState(initialVariant);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (type !== "all") params.set("type", type);
    for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);
    if (variant) params.set("variantId", variant.id);
    if (locationId !== "all") params.set("locationId", locationId);

    fetchJson<{ items: StockMovementRow[]; total: number }>(`/api/inventory/movements?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the ledger."));
  }, [debouncedQ, type, range, variant, locationId, page, pageSize]);

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    pager.reset();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search SKU, product or note..." value={q} onChange={(e) => updateFilter(setQ, e.target.value)} className="pl-8" />
        </div>
        <Select value={type} onValueChange={(v) => updateFilter(setType, v as "all" | StockMovementTypeValue)}>
          <SelectTrigger className="w-full lg:w-48">
            <SelectValue placeholder="Movement type">
              {(value: "all" | StockMovementTypeValue) => (value === "all" ? "All movement types" : STOCK_MOVEMENT_LABELS[value])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All movement types</SelectItem>
            {STOCK_MOVEMENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {STOCK_MOVEMENT_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={locationId} onValueChange={(v) => updateFilter(setLocationId, v as string)}>
          <SelectTrigger className="w-full lg:w-52">
            <SelectValue placeholder="Location">{(value: string) => (value === "all" ? "All locations" : (locations.find((l) => l.id === value)?.name ?? "Location"))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DateRangeFilter value={range} onChange={(v) => updateFilter(setRange, v)} />
      </div>

      {variant ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Showing one variant:</span>
          <Badge variant="secondary" className="font-mono">
            {variant.sku}
          </Badge>
          <Button variant="ghost" size="icon-xs" aria-label="Show all variants" onClick={() => updateFilter(setVariant, null)}>
            <X />
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <History className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No stock movements</p>
          <p className="text-sm text-muted-foreground">Try a wider date range or a different type.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">After (here / total)</TableHead>
              {hasCostAccess ? <TableHead className="text-right">Unit cost</TableHead> : null}
              <TableHead>Reference</TableHead>
              <TableHead>By / note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDhakaDateTime(m.createdAt)}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: m.variant.colorHex }} />
                    <span className="font-medium">{m.variant.productName}</span>
                  </span>
                  <div className="text-xs">
                    <span className="font-semibold">
                      {m.variant.sizeName} / {m.variant.colorName}
                    </span>{" "}
                    <span className="font-mono text-muted-foreground">{m.variant.sku}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={m.qty > 0 ? "secondary" : m.type === "DAMAGE_OUT" ? "destructive" : "outline"}>{STOCK_MOVEMENT_LABELS[m.type]}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{m.location.name}</TableCell>
                <TableCell className={`text-right font-semibold tabular-nums ${m.qty > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
                  {m.qty > 0 ? `+${m.qty}` : m.qty}
                </TableCell>
                <TableCell className="text-right tabular-nums whitespace-nowrap">
                  <span className={m.locationStockAfter < 0 ? "font-semibold text-destructive" : ""}>{m.locationStockAfter}</span>
                  <span className="text-muted-foreground"> / {m.stockAfter}</span>
                </TableCell>
                {hasCostAccess ? (
                  <TableCell className="text-right text-muted-foreground tabular-nums">{m.unitCostSnapshot ? formatBDT(m.unitCostSnapshot) : "—"}</TableCell>
                ) : null}
                <TableCell>
                  <div className="text-xs text-muted-foreground">{STOCK_REFERENCE_LABELS[m.referenceType] ?? m.referenceType}</div>
                  {m.referenceLabel ? (
                    m.referenceHref ? (
                      <Link href={m.referenceHref} className="text-sm hover:underline">
                        {m.referenceLabel}
                      </Link>
                    ) : (
                      <span className="text-sm">{m.referenceLabel}</span>
                    )
                  ) : null}
                </TableCell>
                <TableCell className="max-w-64">
                  <div className="text-sm">{m.actorName ?? "System"}</div>
                  {m.note ? <div className="truncate text-xs text-muted-foreground" title={m.note}>{m.note}</div> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <ListPagination page={page} pageSize={pageSize} total={total} noun="movements" onPageChange={setPage} onPageSizeChange={pager.setPageSize} />
      ) : null}
    </div>
  );
}
