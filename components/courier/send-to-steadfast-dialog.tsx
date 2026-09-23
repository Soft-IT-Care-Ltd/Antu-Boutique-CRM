"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { estimateCourierCost, formatWeight } from "@/lib/courier/constants";
import type { CostRateView, SendPreviewRowView, SendResultRowView } from "@/lib/courier/types";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { DELIVERY_ZONE_LABELS, DELIVERY_ZONE_VALUES, type DeliveryZoneValue } from "@/lib/orders/constants";

type Edit = { zone: DeliveryZoneValue | null; weightGrams: string };

// STEADFAST_INTEGRATION.md §2 confirm dialog: per order — order no, customer,
// the phone exactly as Steadfast will get it, address, what's in the parcel,
// COD (only for roles that may see order money) — and every blocker, BEFORE
// anything is booked. Only rows without a blocker are sent.
export function SendToSteadfastDialog({
  orderIds,
  onOpenChange,
  onDone,
}: {
  orderIds: string[] | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const open = orderIds !== null && orderIds.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <SendDialogBody key={orderIds.join(",")} orderIds={orderIds} onOpenChange={onOpenChange} onDone={onDone} /> : null}
    </Dialog>
  );
}

// Keyed by the selected orders, so every opening starts from a fresh preview.
function SendDialogBody({ orderIds, onOpenChange, onDone }: { orderIds: string[]; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [rows, setRows] = useState<SendPreviewRowView[] | null>(null);
  const [rates, setRates] = useState<CostRateView[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [results, setResults] = useState<SendResultRowView[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ rows: SendPreviewRowView[] }>("/api/courier/steadfast/preview", { method: "POST", body: JSON.stringify({ orderIds }) })
      .then((data) => {
        setRows(data.rows);
        setEdits(Object.fromEntries(data.rows.map((r) => [r.orderId, { zone: r.zone, weightGrams: r.weightGrams?.toString() ?? "" }])));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not prepare the send."));
    // Cost rates only load for roles that may see them; a 403 just hides the estimate.
    fetchJson<{ rates: CostRateView[] }>("/api/courier/cost-rates")
      .then((data) => setRates(data.rates))
      .catch(() => setRates(null));
  }, [orderIds]);

  const sendable = rows?.filter((r) => !r.error) ?? [];
  const showCost = rates !== null && rows?.some((r) => "courierCostEstimate" in r);

  function estimateFor(orderId: string): number | null {
    const edit = edits[orderId];
    const rate = rates?.find((r) => r.zone === edit?.zone);
    if (!edit?.zone || !rate) return null;
    return estimateCourierCost({ baseRate: Number(rate.baseRate ?? 0), perKgRate: Number(rate.perKgRate ?? 0) }, edit.weightGrams ? Number(edit.weightGrams) : null);
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const data = await fetchJson<{ results: SendResultRowView[] }>("/api/courier/steadfast/send", {
        method: "POST",
        body: JSON.stringify({
          orderIds: sendable.map((r) => r.orderId),
          overrides: sendable.map((r) => ({
            orderId: r.orderId,
            zone: edits[r.orderId]?.zone ?? null,
            weightGrams: edits[r.orderId]?.weightGrams ? Number(edits[r.orderId].weightGrams) : null,
          })),
        }),
      });
      setResults(data.results);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sending failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{results ? "Steadfast results" : `Send ${orderIds.length} order${orderIds.length === 1 ? "" : "s"} to Steadfast`}</DialogTitle>
        <DialogDescription>
          {results
            ? "Sent orders moved to Handed to courier. Anything that failed is still Packed."
            : "Check each parcel. This books real consignments at Steadfast — the rider sees the delivery instructions, never the internal note."}
        </DialogDescription>
      </DialogHeader>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {results ? (
        <div className="flex flex-col gap-2">
          {results.map((r) => (
            <div key={r.orderId} className="flex items-start gap-2 rounded-md border p-2 text-sm">
              {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
              <div className="min-w-0">
                <div className="font-mono font-medium">{r.orderNo}</div>
                {r.ok ? (
                  <div className="text-muted-foreground">
                    Consignment <span className="font-mono">{r.consignmentId}</span> · tracking <span className="font-mono">{r.trackingCode ?? "—"}</span>
                  </div>
                ) : (
                  <div className="text-destructive">{r.error}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : !rows ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking orders…
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.orderId} className={`rounded-md border p-3 text-sm ${r.error ? "border-destructive/40 bg-destructive/5" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono font-medium">{r.orderNo}</span>
                {r.codAmount !== undefined ? <Badge variant="outline">COD {formatBDT(r.codAmount)}</Badge> : null}
              </div>
              <div className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                <div>
                  <span className="text-muted-foreground">To: </span>
                  {r.customerName} ·{" "}
                  <span className={`font-mono ${r.normalizedPhone ? "" : "text-destructive"}`}>{r.normalizedPhone ?? r.phone}</span>
                </div>
                <div className="truncate">
                  <span className="text-muted-foreground">Address: </span>
                  {r.address || "—"}
                </div>
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground">Items: </span>
                  {r.itemDescription}
                </div>
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground">Rider note: </span>
                  {r.deliveryNote || <span className="text-muted-foreground">none</span>}
                </div>
              </div>
              {!r.error ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select
                    value={edits[r.orderId]?.zone ?? ""}
                    onValueChange={(v) => setEdits((prev) => ({ ...prev, [r.orderId]: { ...prev[r.orderId], zone: (v as DeliveryZoneValue) || null } }))}
                  >
                    <SelectTrigger className="h-8 w-36">
                      <SelectValue placeholder="Zone">{(value: string) => (value ? DELIVERY_ZONE_LABELS[value as DeliveryZoneValue] : "Zone")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {DELIVERY_ZONE_VALUES.map((z) => (
                        <SelectItem key={z} value={z}>
                          {DELIVERY_ZONE_LABELS[z]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      className="h-8 w-24"
                      placeholder="Weight"
                      value={edits[r.orderId]?.weightGrams ?? ""}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [r.orderId]: { ...prev[r.orderId], weightGrams: e.target.value } }))}
                    />
                    <span className="text-xs text-muted-foreground">g</span>
                  </div>
                  {!r.weightComplete ? (
                    <span className="flex items-center gap-1 text-xs text-amber-600">
                      <AlertTriangle className="size-3" /> {r.weightGrams ? `${formatWeight(r.weightGrams)} — some items have no weight` : "No item weights set"}
                    </span>
                  ) : null}
                  {showCost ? (
                    <span className="text-xs text-muted-foreground">
                      Est. courier cost: {estimateFor(r.orderId) === null ? "—" : formatBDT(estimateFor(r.orderId)!)}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 flex items-center gap-1 text-destructive">
                  <XCircle className="size-4" /> {r.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <DialogFooter>
        {results ? (
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={send} disabled={sending || sendable.length === 0}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : null}
              Send {sendable.length} to Steadfast
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
