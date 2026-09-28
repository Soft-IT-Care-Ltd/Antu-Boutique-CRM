"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Search, Truck } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { NewTransferDialog } from "@/components/transfers/new-transfer-dialog";
import { TransferStatusBadge } from "@/components/transfers/transfer-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import type { LocationOption } from "@/lib/locations/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { TRANSFER_TAB_LABELS, TRANSFER_TABS, type TransferListItem, type TransferTab } from "@/lib/transfers/constants";

type ListResponse = { items: TransferListItem[]; total: number; counts: Record<TransferTab, number> };

export function TransferList({ locations, sendFrom }: { locations: LocationOption[]; sendFrom: LocationOption[] }) {
  const [tab, setTab] = useState<TransferTab>("open");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [locationId, setLocationId] = useState("all");
  const [range, setRange] = useState<DateRangeValue>({ preset: "this_month" });
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pager = usePager("transfers");
  const { page, pageSize, setPage } = pager;
  // Open work never hides behind a date (C2); finished work defaults to this month.
  const dated = tab === "done" || tab === "all";

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ tab, page: String(page), pageSize: String(pageSize) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (locationId !== "all") params.set("locationId", locationId);
    if (dated) for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);
    let live = true;
    fetchJson<ListResponse>(`/api/inventory/transfers?${params.toString()}`)
      .then((res) => {
        if (!live) return;
        setData(res);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load transfers."));
    return () => {
      live = false;
    };
  }, [tab, debouncedQ, locationId, range, dated, page, pageSize]);

  function update<T>(setter: (v: T) => void, v: T) {
    setter(v);
    pager.reset();
  }

  const items = data?.items ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist" aria-label="Transfer status">
        {TRANSFER_TABS.map((t) => (
          <Button key={t} role="tab" aria-selected={tab === t} size="sm" variant={tab === t ? "nav" : "ghost"} className="shrink-0" onClick={() => update(setTab, t)}>
            {TRANSFER_TAB_LABELS[t]}
            {data ? <span className={`rounded-full px-1.5 text-xs tabular-nums ${t === "difference" && data.counts[t] > 0 ? "bg-destructive text-white" : "bg-muted text-muted-foreground"}`}>{data.counts[t]}</span> : null}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Transfer no., SKU or order no." value={q} onChange={(e) => update(setQ, e.target.value)} className="pl-8" />
        </div>
        <Select value={locationId} onValueChange={(v) => update(setLocationId, v as string)}>
          <SelectTrigger className="w-full lg:w-56">
            <SelectValue>{(v: string) => (v === "all" ? "All locations" : (locations.find((l) => l.id === v)?.name ?? "Location"))}</SelectValue>
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
        {dated ? <DateRangeFilter value={range} onChange={(v) => update(setRange, v)} /> : null}
        <div className="lg:ml-auto">{sendFrom.length > 0 ? <NewTransferDialog sendFrom={sendFrom} locations={locations} /> : null}</div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Truck className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No transfers here</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {tab === "incoming" ? "Nothing is on its way to your locations." : tab === "difference" ? "Nothing is missing in transit." : "Start one with New transfer, or from Needed at hub."}
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden">
            {items.map((t) => (
              <li key={t.id}>
                <Link href={`/inventory/transfers/${t.id}`} className="flex flex-col gap-1.5 rounded-xl border p-3 active:bg-muted">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">{t.transferNo}</span>
                    <TransferStatusBadge status={t.status} />
                  </div>
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{t.fromName}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t.toName}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t.units} unit(s)</span>
                    {t.missing > 0 ? <Badge variant="destructive">{t.missing} missing</Badge> : null}
                    {t.orderCount > 0 ? <span>· for {t.orderCount} order(s)</span> : null}
                    <span>· {formatDhakaDateTime(t.sentAt ?? t.createdAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transfer</TableHead>
                  <TableHead>From → to</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/inventory/transfers/${t.id}`} className="font-mono font-semibold hover:underline">
                        {t.transferNo}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        {t.fromName} <ArrowRight className="size-3.5 text-muted-foreground" /> {t.toName}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <TransferStatusBadge status={t.status} />
                        {t.missing > 0 ? <Badge variant="destructive">{t.missing} missing</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{t.units}</TableCell>
                    <TableCell className="text-muted-foreground">{t.orderCount || "—"}</TableCell>
                    <TableCell className="text-sm">
                      {formatDhakaDateTime(t.createdAt)}
                      <div className="text-xs text-muted-foreground">{t.createdByName ?? ""}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t.sentAt ? formatDhakaDateTime(t.sentAt) : "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t.receivedAt ? formatDhakaDateTime(t.receivedAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ListPagination page={page} pageSize={pageSize} total={data?.total ?? 0} noun="transfers" onPageChange={setPage} onPageSizeChange={pager.setPageSize} />
        </>
      )}
    </div>
  );
}
