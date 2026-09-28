"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ClipboardList, Loader2, Plus } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import type { LocationOption } from "@/lib/locations/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import {
  STOCK_COUNT_SCOPE_LABELS,
  STOCK_COUNT_SCOPES,
  STOCK_COUNT_STATUS_LABELS,
  STOCK_COUNT_STATUSES,
  type StockCountListItem,
  type StockCountScopeValue,
  type StockCountStatusValue,
} from "@/lib/stock-counts/constants";
import { STOCK_COUNT_STATUS_TONE } from "@/lib/ui/status-tone";
import { cn } from "@/lib/utils";

export function StockCountList({ locations, canStart }: { locations: LocationOption[]; canStart: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<"all" | StockCountStatusValue>("all");
  // Counts in progress always show; finished ones default to this month (C2).
  const [range, setRange] = useState<DateRangeValue>({ preset: "this_month" });
  const [data, setData] = useState<{ items: StockCountListItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pager = usePager("stock_counts");
  const { page, pageSize, setPage } = pager;
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [scope, setScope] = useState<StockCountScopeValue>("SPOT");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status !== "all") params.set("status", status);
    if (status !== "OPEN") for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);
    let live = true;
    fetchJson<{ items: StockCountListItem[]; total: number }>(`/api/inventory/counts?${params.toString()}`)
      .then((res) => live && (setData(res), setError(null)))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load stock counts."));
    return () => {
      live = false;
    };
  }, [status, range, page, pageSize]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { count } = await fetchJson<{ count: { id: string } }>("/api/inventory/counts", { method: "POST", body: JSON.stringify({ locationId, scope }) });
      router.push(`/inventory/counts/${count.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the count.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="-mx-4 flex flex-1 gap-1 overflow-x-auto px-4 md:mx-0 md:px-0">
          {(["all", ...STOCK_COUNT_STATUSES] as const).map((s) => (
            <Button key={s} size="sm" variant={status === s ? "nav" : "ghost"} className="shrink-0" onClick={() => (setStatus(s), pager.reset())}>
              {s === "all" ? "All" : STOCK_COUNT_STATUS_LABELS[s]}
            </Button>
          ))}
        </div>
        {status !== "OPEN" ? <DateRangeFilter value={range} onChange={(v) => (setRange(v), pager.reset())} /> : null}
        {canStart ? (
          <Button onClick={() => setOpen(true)} disabled={locations.length === 0} title={locations.length === 0 ? "You aren't assigned to any location" : undefined}>
            <Plus /> New count
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <ClipboardList className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No stock counts yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Start one, then scan every dress on the shelf. A few shelves a day keeps the figures right.</p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {data.items.map((c) => (
              <li key={c.id}>
                <Link href={`/inventory/counts/${c.id}`} className="flex flex-col gap-1 rounded-xl border p-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex items-center gap-2 sm:w-56">
                    <span className="font-mono font-semibold">{c.countNo}</span>
                    <Badge variant={STOCK_COUNT_STATUS_TONE[c.status]}>{STOCK_COUNT_STATUS_LABELS[c.status]}</Badge>
                  </div>
                  <div className="flex-1 text-sm">
                    <span className="font-medium">{c.locationName}</span>
                    <span className="text-muted-foreground"> · {STOCK_COUNT_SCOPE_LABELS[c.scope].label}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                    <span>
                      {c.units} unit(s), {c.items} item(s)
                    </span>
                    {c.differences !== null ? <span className={cn(c.differences > 0 && "font-medium text-amber-700 dark:text-amber-400")}>{c.differences} difference(s)</span> : null}
                    <span>
                      {formatDhakaDateTime(c.postedAt ?? c.createdAt)} · {c.createdByName ?? ""}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <ListPagination page={page} pageSize={pageSize} total={data.total} noun="counts" onPageChange={setPage} onPageSizeChange={pager.setPageSize} />
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New stock count</DialogTitle>
            <DialogDescription>Nothing changes until a manager posts the count.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label>Location</Label>
            <Select value={locationId} onValueChange={(v) => setLocationId(v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => locations.find((l) => l.id === v)?.name ?? "Pick a location"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {STOCK_COUNT_SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                aria-pressed={scope === s}
                className={cn("flex flex-col gap-1 rounded-lg border p-3 text-left text-sm", scope === s ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50")}
              >
                <span className="font-medium">{STOCK_COUNT_SCOPE_LABELS[s].label}</span>
                <span className="text-xs text-muted-foreground">{STOCK_COUNT_SCOPE_LABELS[s].hint}</span>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={start} disabled={busy || !locationId}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Start counting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
