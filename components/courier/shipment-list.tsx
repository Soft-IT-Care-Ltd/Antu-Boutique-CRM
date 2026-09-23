"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Loader2, PackageCheck, RefreshCw, Search, Send, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SendToSteadfastDialog } from "@/components/courier/send-to-steadfast-dialog";
import { SHIPMENT_SUB_STATUS_LABELS, type CourierShipmentTab } from "@/lib/courier/constants";
import type { ReadyToShipRow, ShipmentRow } from "@/lib/courier/types";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";

const PAGE_SIZE = 20;

const TAB_LABELS: Record<CourierShipmentTab, string> = {
  ready: "Ready to ship",
  active: "With courier",
  attention: "Needs attention",
  delivered: "Delivered",
  returned: "Returned",
};

const EMPTY_TEXT: Record<CourierShipmentTab, string> = {
  ready: "No packed orders waiting. Orders appear here once Packing marks them packed.",
  active: "Nothing is out with the courier right now.",
  attention: "Nothing needs attention. On-hold parcels, unrecognised courier statuses and partial deliveries awaiting Accounts land here.",
  delivered: "No delivered parcels yet.",
  returned: "No returned parcels.",
};

type ListResponse = { tab: CourierShipmentTab; items: (ReadyToShipRow | ShipmentRow)[]; total: number; counts: Record<CourierShipmentTab, number> };

export function ShipmentList({ canSend, canSync, canReconcile }: { canSend: boolean; canSync: boolean; canReconcile: boolean }) {
  const [tab, setTab] = useState<CourierShipmentTab>("ready");
  const [data, setData] = useState<ListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendIds, setSendIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ tab, page: String(page), pageSize: String(PAGE_SIZE) });
    if (debouncedQ) params.set("q", debouncedQ);
    fetchJson<ListResponse>(`/api/courier/shipments?${params}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load shipments."));
  }, [tab, page, debouncedQ, reloadKey]);

  const reload = useCallback(() => {
    setSelected(new Set());
    setReloadKey((k) => k + 1);
  }, []);

  function switchTab(next: CourierShipmentTab) {
    setTab(next);
    setPage(1);
    setSelected(new Set());
    setMessage(null);
  }

  async function refreshOne(shipmentId: string) {
    setBusy(shipmentId);
    setMessage(null);
    try {
      const res = await fetchJson<{ polled: number; changed: number; errors: { error: string }[] }>("/api/courier/steadfast/sync", {
        method: "POST",
        body: JSON.stringify({ shipmentId }),
      });
      setMessage(res.errors.length ? `Sync failed: ${res.errors[0].error}` : res.polled === 0 ? "Nothing to sync — this parcel is already final." : res.changed ? "Status updated." : "No change at Steadfast.");
      reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Sync failed.");
    } finally {
      setBusy(null);
    }
  }

  async function markReviewed(shipmentId: string) {
    setBusy(shipmentId);
    try {
      await fetchJson(`/api/courier/shipments/${shipmentId}/accounts-review`, { method: "POST", body: "{}" });
      reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not mark reviewed.");
    } finally {
      setBusy(null);
    }
  }

  const items = data?.tab === tab ? data.items : null;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const readyRows = tab === "ready" ? ((items ?? []) as ReadyToShipRow[]) : [];
  const selectableIds = readyRows.filter((r) => !r.bookingInProgress).map((r) => r.orderId);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(TAB_LABELS) as CourierShipmentTab[]).map((t) => (
          <Button key={t} size="sm" variant={t === tab ? "default" : "outline"} onClick={() => switchTab(t)}>
            {TAB_LABELS[t]}
            {data?.counts ? <span className={t === "attention" && data.counts[t] > 0 ? "font-semibold text-amber-500" : "opacity-70"}>{data.counts[t]}</span> : null}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Order no, customer, phone, consignment…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            className="pl-8"
          />
        </div>
        {tab === "ready" && canSend ? (
          <Button disabled={selected.size === 0} onClick={() => setSendIds([...selected])}>
            <Send />
            Send {selected.size > 0 ? selected.size : ""} to Steadfast
          </Button>
        ) : null}
      </div>

      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-14 text-center">
          {tab === "ready" ? <PackageCheck className="size-8 text-muted-foreground" /> : <Truck className="size-8 text-muted-foreground" />}
          <p className="max-w-sm text-sm text-muted-foreground">{debouncedQ ? "No matches for that search." : EMPTY_TEXT[tab]}</p>
        </div>
      ) : tab === "ready" ? (
        <Table>
          <TableHeader>
            <TableRow>
              {canSend ? (
                <TableHead className="w-8">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelected(checked ? new Set(selectableIds) : new Set())}
                    aria-label="Select all"
                  />
                </TableHead>
              ) : null}
              <TableHead>Order</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="hidden md:table-cell">Items</TableHead>
              {readyRows.some((r) => r.codAmount !== undefined) ? <TableHead>COD</TableHead> : null}
              {canSend ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {readyRows.map((r) => (
              <TableRow key={r.orderId}>
                {canSend ? (
                  <TableCell>
                    <Checkbox
                      checked={selected.has(r.orderId)}
                      disabled={r.bookingInProgress}
                      onCheckedChange={(checked) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(r.orderId);
                          else next.delete(r.orderId);
                          return next;
                        })
                      }
                      aria-label={`Select ${r.orderNo}`}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <div className="font-mono font-medium">{r.orderNo}</div>
                  {r.bookingInProgress ? <Badge variant="outline">Booking in progress</Badge> : null}
                </TableCell>
                <TableCell>
                  <div>{r.customerName}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.phone}</div>
                  <div className="max-w-56 truncate text-xs text-muted-foreground">{r.address || "No address"}</div>
                </TableCell>
                <TableCell className="hidden max-w-72 text-xs md:table-cell">
                  {r.items.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </TableCell>
                {r.codAmount !== undefined ? <TableCell>{formatBDT(r.codAmount)}</TableCell> : null}
                {canSend ? (
                  <TableCell>
                    <Button size="sm" variant="outline" disabled={r.bookingInProgress} onClick={() => setSendIds([r.orderId])}>
                      Send
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead className="hidden sm:table-cell">Customer</TableHead>
              <TableHead>Consignment</TableHead>
              <TableHead>Courier status</TableHead>
              {(items as ShipmentRow[]).some((r) => r.codAmount !== undefined) ? <TableHead className="hidden md:table-cell">COD</TableHead> : null}
              {(items as ShipmentRow[]).some((r) => "courierCostEstimate" in r) ? <TableHead className="hidden lg:table-cell">Courier cost</TableHead> : null}
              <TableHead className="hidden md:table-cell">Last update</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items as ShipmentRow[]).map((r) => (
              <TableRow key={r.shipmentId}>
                <TableCell>
                  <Link href={`/orders/${r.orderId}`} className="font-mono font-medium hover:underline">
                    {r.orderNo}
                  </Link>
                  <div className="text-xs text-muted-foreground">{ORDER_STATUS_LABELS[r.orderStatus]}</div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <div>{r.customerName}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.phone}</div>
                </TableCell>
                <TableCell>
                  <div className="font-mono text-xs">{r.consignmentId ?? "—"}</div>
                  {r.trackingUrl ? (
                    <a href={r.trackingUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
                      {r.trackingCode ?? "Track"} <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline" className="font-mono">
                      {r.steadfastStatus ?? "—"}
                    </Badge>
                    {r.subStatus && !r.finalizedAt ? <Badge variant="secondary">{SHIPMENT_SUB_STATUS_LABELS[r.subStatus]}</Badge> : null}
                    {r.onHold ? <Badge variant="destructive">On hold</Badge> : null}
                    {r.accountsReviewRequired ? <Badge variant="destructive">Accounts review</Badge> : null}
                  </div>
                  {r.orderStatus === "IN_TRANSIT" ? (
                    // Rider details aren't in Steadfast's API; scraping is out of scope (Gift Valy Round 2 §2.4 fallback).
                    <p className="mt-1 text-xs text-muted-foreground">
                      Rider: —{" "}
                      {r.trackingUrl ? (
                        <a href={r.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          view tracking page
                        </a>
                      ) : null}
                    </p>
                  ) : null}
                  {r.needsAttention && r.attentionReason ? (
                    <p className="mt-1 flex max-w-64 items-start gap-1 text-xs text-amber-600">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {r.attentionReason}
                    </p>
                  ) : null}
                </TableCell>
                {r.codAmount !== undefined ? (
                  <TableCell className="hidden md:table-cell">
                    <div>{formatBDT(r.codAmount)}</div>
                    {r.codCollected ? <div className="text-xs text-muted-foreground">Collected {formatBDT(r.codCollected)}</div> : null}
                    {r.deliveredAt && !r.codReceivedAt ? <div className="text-xs text-amber-600">Payout pending</div> : null}
                  </TableCell>
                ) : null}
                {"courierCostEstimate" in r ? (
                  <TableCell className="hidden text-xs lg:table-cell">
                    {r.courierCostActual ? (
                      <span>{formatBDT(r.courierCostActual)} <span className="text-muted-foreground">actual</span></span>
                    ) : r.courierCostEstimate ? (
                      <span>{formatBDT(r.courierCostEstimate)} <span className="text-muted-foreground">est.</span></span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{r.lastStatusAt ? formatDhakaDateTime(r.lastStatusAt) : "—"}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {canReconcile && r.accountsReviewRequired ? (
                      <Button size="sm" variant="outline" disabled={busy === r.shipmentId} onClick={() => markReviewed(r.shipmentId)}>
                        Mark reviewed
                      </Button>
                    ) : null}
                    {canSync && !r.finalizedAt ? (
                      <Button size="icon-sm" variant="ghost" title="Refresh from Steadfast" disabled={busy === r.shipmentId} onClick={() => refreshOne(r.shipmentId)}>
                        {busy === r.shipmentId ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {data?.total ?? 0}
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

      <SendToSteadfastDialog orderIds={sendIds} onOpenChange={(open) => !open && setSendIds(null)} onDone={reload} />
    </div>
  );
}
