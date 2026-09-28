"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus, ReceiptText, Search } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { formatDhakaDate } from "@/lib/inventory/constants";
import type { PurchaseListItem } from "@/lib/inventory/types";
import { formatBDT } from "@/lib/money";

type Props = { suppliers: { id: string; name: string }[]; initialSupplierId: string | null };

export function PurchaseList({ suppliers, initialSupplierId }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<PurchaseListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const pager = usePager("purchases");
  const { page, pageSize, setPage } = pager;
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [supplierId, setSupplierId] = useState(initialSupplierId ?? "all");
  const [dueOnly, setDueOnly] = useState(false);
  const [range, setRange] = useState<DateRangeValue>({ preset: "all" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (supplierId !== "all") params.set("supplierId", supplierId);
    if (dueOnly) params.set("due", "true");
    for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);

    fetchJson<{ items: PurchaseListItem[]; total: number }>(`/api/inventory/purchases?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load purchases."));
  }, [debouncedQ, supplierId, dueOnly, range, page, pageSize]);

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    pager.reset();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Invoice no., supplier or SKU..." value={q} onChange={(e) => updateFilter(setQ, e.target.value)} className="pl-8" />
          </div>
          <Select value={supplierId} onValueChange={(v) => updateFilter(setSupplierId, v as string)}>
            <SelectTrigger className="w-full lg:w-52">
              <SelectValue placeholder="Supplier">
                {(value: string) => (value === "all" ? "All suppliers" : (suppliers.find((s) => s.id === value)?.name ?? "Supplier"))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DateRangeFilter value={range} onChange={(v) => updateFilter(setRange, v)} />
          <label className="flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground">
            <Switch checked={dueOnly} onCheckedChange={(checked) => updateFilter(setDueOnly, checked)} />
            Due only
          </label>
        </div>
        <Button render={<Link href="/inventory/purchases/new" />} nativeButton={false}>
          <Plus />
          New purchase
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <ReceiptText className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No purchases found</p>
          <p className="text-sm text-muted-foreground">Record a purchase to bring stock in and update average cost.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/inventory/purchases/${p.id}`)}>
                <TableCell className="whitespace-nowrap">{formatDhakaDate(p.purchaseDate)}</TableCell>
                <TableCell className="font-medium">{p.supplierName}</TableCell>
                <TableCell className="font-mono text-sm">{p.invoiceNo ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.totalQty} <span className="text-xs text-muted-foreground">({p.itemCount} lines)</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatBDT(p.totalCost)}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{formatBDT(p.amountPaid)}</TableCell>
                <TableCell className={`text-right tabular-nums ${Number(p.dueAmount) > 0 ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                  {formatBDT(p.dueAmount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <ListPagination page={page} pageSize={pageSize} total={total} noun="purchases" onPageChange={setPage} onPageSizeChange={pager.setPageSize} />
      ) : null}
    </div>
  );
}
