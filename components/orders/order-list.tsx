"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, ShoppingBag } from "lucide-react";

import { ChannelSelect, type ChannelFilterValue } from "@/components/orders/channel-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBDT } from "@/lib/money";
import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_STATUS_LABELS, ORDER_STATUS_VALUES } from "@/lib/orders/constants";
import type { OrderListItem } from "@/lib/orders/types";
import type { OrderStatusValue } from "@/lib/orders/constants";

const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Partial<Record<OrderStatusValue, "default" | "secondary" | "destructive" | "outline">> = {
  LEAD: "outline",
  CONFIRMED: "secondary",
  PACKED: "secondary",
  HANDED_TO_COURIER: "secondary",
  IN_TRANSIT: "secondary",
  DELIVERED: "default",
  COMPLETED: "default",
  ON_HOLD: "outline",
  CANCELLED: "destructive",
  RETURNED: "destructive",
  REFUNDED: "destructive",
  EXCHANGE_REQUESTED: "outline",
  PARTIAL_DELIVERED: "outline",
};

export function OrderList({ canCreate, canFilterBySe }: { canCreate: boolean; canFilterBySe: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<OrderListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("all");
  const [channel, setChannel] = useState<ChannelFilterValue>("all");
  const [createdById, setCreatedById] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [salesExecutives, setSalesExecutives] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (status !== "all") params.set("status", status);
    if (channel !== "all") params.set("channel", channel);
    if (createdById !== "all") params.set("createdById", createdById);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));

    fetchJson<{ items: OrderListItem[]; total: number }>(`/api/orders?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load orders."));
  }, [debouncedQ, status, channel, createdById, from, to, page]);

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Order no, name, or phone..."
              value={q}
              onChange={(e) => updateFilter(setQ, e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={status} onValueChange={(v) => updateFilter(setStatus, v as string)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Status">
                {(value: string) => (value === "all" ? "All statuses" : ORDER_STATUS_LABELS[value as OrderStatusValue])}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ORDER_STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {ORDER_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <Input type="date" value={from} onChange={(e) => updateFilter(setFrom, e.target.value)} className="w-36" />
          <Input type="date" value={to} onChange={(e) => updateFilter(setTo, e.target.value)} className="w-36" />
        </div>
        {canCreate ? (
          <Button render={<Link href="/orders/new" />} nativeButton={false}>
            <Plus />
            New order
          </Button>
        ) : null}
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
          <ShoppingBag className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No orders found</p>
          <p className="text-sm text-muted-foreground">Try different filters, or create a new order.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order no.</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Sales executive</TableHead>
              <TableHead>Placed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((order) => (
              <TableRow key={order.id} className="cursor-pointer" onClick={() => router.push(`/orders/${order.id}`)}>
                <TableCell className="font-mono font-medium">{order.orderNo}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    {order.customer?.name ?? <span className="text-muted-foreground">{WALK_IN_CUSTOMER_LABEL}</span>}
                    {order.channel === "WALK_IN" ? <Badge variant="outline">Walk-in</Badge> : null}
                  </div>
                  {order.customer ? <div className="font-mono text-xs text-muted-foreground">{order.customer.phone}</div> : null}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE_VARIANT[order.status] ?? "outline"}>{ORDER_STATUS_LABELS[order.status]}</Badge>
                </TableCell>
                <TableCell>{formatBDT(order.total)}</TableCell>
                <TableCell className={Number(order.dueAmount) > 0 ? "text-amber-600" : "text-muted-foreground"}>
                  {formatBDT(order.dueAmount)}
                </TableCell>
                <TableCell className="text-muted-foreground">{order.createdBy?.name ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(order.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {total} orders
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
