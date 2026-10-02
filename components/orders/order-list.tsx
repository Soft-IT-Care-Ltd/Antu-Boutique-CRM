"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Plus, Search, ShoppingBag, X } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { ChannelSelect, type ChannelFilterValue } from "@/components/orders/channel-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FULFILMENT_STATUS_LABELS, FULFILMENT_STATUS_TONE } from "@/lib/fulfilment/constants";
import { dateRangeQuery, dateRangeToParams, describeDateRange, type DateRangeValue } from "@/lib/date-range";
import { formatBDT } from "@/lib/money";
import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { ORDER_TAB_BY_KEY, ORDER_TABS, type OrderSubTabKey, type OrderTabCounts, type OrderTabKey } from "@/lib/orders/tabs";
import { ORDER_STATUS_TONE } from "@/lib/ui/status-tone";
import { cn } from "@/lib/utils";
import type { OrderListItem } from "@/lib/orders/types";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { ORDER_DATE_BASIS_LABELS, ORDER_LIST_PRESET_HINTS, ORDER_LIST_PRESET_LABELS, type OrderDateBasis, type OrderListPreset } from "@/lib/orders/list-presets";

/** Where the list opens — from the URL (a dashboard number, or a reload). */
export type OrderListInitialFilters = {
  tab: OrderTabKey;
  sub?: OrderSubTabKey;
  range: DateRangeValue;
  status?: OrderStatusValue;
  channel?: "ONLINE" | "WALK_IN";
  createdById?: string;
  dateBy?: OrderDateBasis;
  preset?: OrderListPreset;
};

export function OrderList({ canCreate, canFilterBySe, initialFilters }: { canCreate: boolean; canFilterBySe: boolean; initialFilters: OrderListInitialFilters }) {
  const router = useRouter();
  const pager = usePager("orders");
  const [items, setItems] = useState<OrderListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sums, setSums] = useState<{ value: string; due: string } | null>(null);
  const [counts, setCounts] = useState<OrderTabCounts | null>(null);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [tab, setTab] = useState<OrderTabKey>(initialFilters.tab);
  const [sub, setSub] = useState<OrderSubTabKey | undefined>(initialFilters.sub);
  const [status, setStatus] = useState<OrderStatusValue | undefined>(initialFilters.status);
  const [channel, setChannel] = useState<ChannelFilterValue>(initialFilters.channel ?? "all");
  const [createdById, setCreatedById] = useState(initialFilters.createdById ?? "all");
  const [range, setRange] = useState<DateRangeValue>(initialFilters.range);
  const [dateBy, setDateBy] = useState<OrderDateBasis>(initialFilters.dateBy ?? "placed");
  const [preset, setPreset] = useState<OrderListPreset | null>(initialFilters.preset ?? null);
  const [salesExecutives, setSalesExecutives] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const tabDef = ORDER_TAB_BY_KEY[tab];
  const { page, pageSize, reset } = pager;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    if (!canFilterBySe) return;
    fetchJson<{ users: { id: string; name: string }[] }>("/api/orders/sales-executives")
      .then((data) => setSalesExecutives(data.users))
      .catch(() => {});
  }, [canFilterBySe]);

  // Everything but the tab, status and page — shared by the rows and the tab counts.
  const filterQuery = (() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (channel !== "all") params.set("channel", channel);
    if (createdById !== "all") params.set("createdById", createdById);
    for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);
    if (dateBy !== "placed") params.set("dateBy", dateBy);
    if (preset) params.set("preset", preset);
    return params.toString();
  })();

  useEffect(() => {
    fetchJson<OrderTabCounts>(`/api/orders/tab-counts?${filterQuery}`)
      .then(setCounts)
      .catch(() => {});
  }, [filterQuery]);

  useEffect(() => {
    const params = new URLSearchParams(filterQuery);
    params.set("tab", tab);
    if (sub) params.set("sub", sub);
    // A dashboard link's single status narrows the rows, never the tab counts.
    if (status) params.set("status", status);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    fetchJson<{ items: OrderListItem[]; total: number; totalValue: string; totalDue: string }>(`/api/orders?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setSums({ value: data.totalValue, due: data.totalDue });
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load orders."));
  }, [filterQuery, tab, sub, status, page, pageSize]);

  // Keep the URL in step (without a navigation) so Back from an order and a
  // reload land on the same tab, dates and filters.
  useEffect(() => {
    const params = new URLSearchParams();
    if (tab !== "all") params.set("tab", tab);
    if (sub) params.set("sub", sub);
    for (const [k, v] of Object.entries(dateRangeToParams(range))) params.set(k, v);
    if (status) params.set("status", status);
    if (channel !== "all") params.set("channel", channel);
    if (createdById !== "all") params.set("createdById", createdById);
    if (dateBy !== "placed") params.set("dateBy", dateBy);
    if (preset) params.set("preset", preset);
    window.history.replaceState(null, "", `/orders?${params.toString()}`);
  }, [tab, sub, range, status, channel, createdById, dateBy, preset]);

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    reset();
  }

  function pickTab(next: OrderTabKey) {
    setTab(next);
    setSub(undefined);
    setStatus(undefined);
    reset();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap gap-2">
          <DateRangeFilter value={range} onChange={(v) => updateFilter(setRange, v)} />
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Order no, name, or phone..." value={q} onChange={(e) => updateFilter(setQ, e.target.value)} className="pl-8" />
          </div>
          <ChannelSelect value={channel} onChange={(v) => updateFilter(setChannel, v)} />
          {canFilterBySe ? (
            <Select value={createdById} onValueChange={(v) => updateFilter(setCreatedById, v as string)}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Sales executive">
                  {(value: string) => (value === "all" ? "Everyone" : (salesExecutives.find((u) => u.id === value)?.name ?? "Sales executive"))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {salesExecutives.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        {canCreate ? (
          <Button render={<Link href="/orders/new" />} nativeButton={false}>
            <Plus />
            New order
          </Button>
        ) : null}
      </div>

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div role="tablist" aria-label="Order status" className="flex w-max gap-1 border-b">
          {ORDER_TABS.map((t) => (
            <TabButton key={t.key} active={tab === t.key} count={counts?.tabs[t.key]} onClick={() => pickTab(t.key)} dimmed={!t.open}>
              {t.label}
            </TabButton>
          ))}
        </div>
      </div>

      {tabDef.subTabs ? (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={`${tabDef.label} — narrow down`}>
          <SubTabButton active={!sub} onClick={() => updateFilter(setSub, undefined)}>
            All
          </SubTabButton>
          {tabDef.subTabs.map((s) => (
            <SubTabButton key={s.key} active={sub === s.key} count={counts?.subTabs[s.key]} onClick={() => updateFilter(setSub, s.key)}>
              {s.label}
            </SubTabButton>
          ))}
        </div>
      ) : null}

      {tab === "waiting_for_stock" ? (
        <p className="text-sm">
          <Link href="/orders/waiting-for-stock" className="font-medium underline underline-offset-4">
            Open the Waiting for stock list
          </Link>{" "}
          <span className="text-muted-foreground">— what each order is missing, days waiting, totals, and what to buy (print, CSV, pre-fill a purchase).</span>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {tabDef.open ? "Every open order is shown here, whatever the dates say — nothing pending is hidden." : `Orders ${ORDER_DATE_BASIS_LABELS[dateBy].toLowerCase()}: ${describeDateRange(range)}.`}
      </p>

      {preset || status || dateBy !== "placed" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {status ? (
            <Badge variant="secondary" className="h-auto gap-1 py-1">
              Only {ORDER_STATUS_LABELS[status]}
              <button type="button" aria-label="Show the whole tab" className="rounded-sm hover:bg-foreground/10" onClick={() => updateFilter(setStatus, undefined)}>
                <X className="size-3" />
              </button>
            </Badge>
          ) : null}
          {preset ? (
            <Badge variant="secondary" className="h-auto gap-1 py-1 whitespace-normal">
              <span title={ORDER_LIST_PRESET_HINTS[preset]}>{ORDER_LIST_PRESET_LABELS[preset]}</span>
              <button type="button" aria-label="Clear this filter" className="rounded-sm hover:bg-foreground/10" onClick={() => updateFilter(setPreset, null)}>
                <X className="size-3" />
              </button>
            </Badge>
          ) : null}
          {dateBy !== "placed" ? (
            <Badge variant="secondary" className="h-auto gap-1 py-1">
              Dates are when it was {ORDER_DATE_BASIS_LABELS[dateBy].toLowerCase()}
              <button type="button" aria-label="Filter by the day it was placed instead" className="rounded-sm hover:bg-foreground/10" onClick={() => updateFilter(setDateBy, "placed")}>
                <X className="size-3" />
              </button>
            </Badge>
          ) : null}
          {preset ? <span className="text-muted-foreground">{ORDER_LIST_PRESET_HINTS[preset]}</span> : null}
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-16 text-center">
          <ShoppingBag className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No orders in {tabDef.label}</p>
          <p className="max-w-md text-sm text-muted-foreground">{tabDef.emptyHint ?? (tabDef.open ? "Nothing waiting here right now." : "Try a wider date range or different filters.")}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order no.</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Due</TableHead>
              <TableHead>Sales executive</TableHead>
              <TableHead>Placed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((order) => (
              <TableRow key={order.id} className="cursor-pointer" onClick={() => router.push(`/orders/${order.id}`)}>
                <TableCell className="font-mono text-xs font-medium">{order.orderNo}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    {order.customer?.name ?? <span className="text-muted-foreground">{WALK_IN_CUSTOMER_LABEL}</span>}
                    {order.channel === "WALK_IN" ? <Badge variant="outline">Walk-in</Badge> : null}
                  </div>
                  {order.customer ? <div className="font-mono text-xs text-muted-foreground">{order.customer.phone}</div> : null}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={ORDER_STATUS_TONE[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
                    {order.fulfilmentStatus && order.fulfilmentStatus !== "READY_TO_PACK" ? (
                      <Badge variant={FULFILMENT_STATUS_TONE[order.fulfilmentStatus]}>{FULFILMENT_STATUS_LABELS[order.fulfilmentStatus]}</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right font-semibold">{formatBDT(order.total)}</TableCell>
                <TableCell className={cn("text-right", Number(order.dueAmount) > 0 ? "text-amber-600" : "text-muted-foreground")}>{formatBDT(order.dueAmount)}</TableCell>
                <TableCell className="text-muted-foreground">{order.createdBy?.name ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(order.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dhaka" })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <ListPagination page={page} pageSize={pageSize} total={total} noun="orders" onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize}>
          {sums ? (
            <>
              {" "}
              · {formatBDT(sums.value)} total · {formatBDT(sums.due)} due
            </>
          ) : null}
        </ListPagination>
      ) : null}
    </div>
  );
}

function TabButton({ active, count, dimmed, onClick, children }: { active: boolean; count?: number; dimmed?: boolean; onClick: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  // On a phone the bar scrolls sideways: keep the open tab in sight (e.g. "All", the last one).
  // Again once the counts arrive: they widen every tab and push it along.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, count]);
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors",
        active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-xs tabular-nums",
            active ? "bg-primary text-primary-foreground" : count > 0 && !dimmed ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground",
          )}
        >
          {count.toLocaleString("en-IN")}
        </span>
      ) : null}
    </button>
  );
}

function SubTabButton({ active, count, onClick, children }: { active: boolean; count?: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
        active ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined ? <span className="tabular-nums">{count.toLocaleString("en-IN")}</span> : null}
    </button>
  );
}
