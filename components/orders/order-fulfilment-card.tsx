"use client";

import { useState } from "react";
import { ArrowLeftRight, CalendarClock, Loader2, PackageX, Trash2, Truck } from "lucide-react";

import { OrderItemPicker, type PickedVariant } from "@/components/orders/order-item-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FULFILMENT_STATUS_LABELS, FULFILMENT_STATUS_TONE } from "@/lib/fulfilment/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import type { OrderDetail, OrderItemView } from "@/lib/orders/types";
import { walletsForMethod, type WalletOption } from "@/lib/wallets/constants";

// C5 — CORRECTIONS.md items 12 and 13 on the order screen: the automatic
// fulfilment status, where every unit of every line is (at the hub, on its
// way, at another location, nowhere), and — for someone holding
// order.fulfilment — the four actions on a missing item. The server
// decides everything; this only collects the choice and the reason.

type Action = "SUBSTITUTE" | "WAIT" | "REMOVE_ITEM" | "CANCEL";
type RefundMethod = (typeof PAYMENT_METHOD_VALUES)[number];

const DAY_MS = 86_400_000;

function whereText(item: OrderItemView): string {
  const f = item.fulfilment;
  if (!f) return "";
  const parts: string[] = [];
  if (f.atHub > 0) parts.push(`${f.atHub} at the packing hub`);
  if (f.incoming > 0) parts.push(`${f.incoming} on the way to the hub`);
  for (const l of f.fromLocations) parts.push(`${l.qty} at ${l.locationName || "another location"}`);
  if (f.backorder > 0) parts.push(`${f.backorder} not in stock anywhere`);
  return parts.join(" · ");
}

export function OrderFulfilmentCard({
  order,
  canAct,
  canSettle,
  wallets,
  onChanged,
}: {
  order: OrderDetail;
  /** order.fulfilment */
  canAct: boolean;
  /** Sees the order's money, so may choose how an overpayment goes back. */
  canSettle: boolean;
  wallets: WalletOption[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<{ action: Action; item: OrderItemView | null } | null>(null);
  // Read once: "waiting N days" doesn't need to tick while the page is open.
  const [now] = useState(() => Date.now());
  if (!order.fulfilmentStatus) return null;

  const status = order.fulfilmentStatus;
  const daysWaiting = order.waitingSince ? Math.floor((now - new Date(order.waitingSince).getTime()) / DAY_MS) : null;
  const anyBackorder = order.items.some((i) => (i.fulfilment?.backorder ?? 0) > 0);
  const lines = order.items.filter((i) => i.fulfilment);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {status === "WAITING_FOR_STOCK" ? <PackageX className="size-4" /> : <Truck className="size-4" />}
          Fulfilment
          <Badge variant={FULFILMENT_STATUS_TONE[status]}>{FULFILMENT_STATUS_LABELS[status]}</Badge>
        </CardTitle>
        <CardDescription>
          {status === "READY_TO_PACK"
            ? "Every piece is at the packing hub."
            : status === "NEEDS_TRANSFER"
              ? "Some pieces are at another location or on their way to the packing hub. It turns Ready to pack when they arrive."
              : `Something on this order isn't in stock anywhere${daysWaiting !== null ? ` — waiting ${daysWaiting === 0 ? "since today" : `${daysWaiting} day${daysWaiting === 1 ? "" : "s"}`}` : ""}. It moves on by itself when stock arrives (oldest order first).`}
          {order.stockExpectedOn ? ` Expected: ${new Date(order.stockExpectedOn).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Dhaka" })}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {canAct && status !== "READY_TO_PACK" ? (
          <div className="mb-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen({ action: "WAIT", item: null })}>
              <CalendarClock />
              Wait
            </Button>
            {anyBackorder ? (
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setOpen({ action: "CANCEL", item: null })}>
                Cancel for stock-out
              </Button>
            ) : null}
          </div>
        ) : null}
        <ul className="flex flex-col divide-y rounded-lg border">
          {lines.map((item) => {
            const missing = item.qty - (item.fulfilment?.atHub ?? 0);
            return (
              <li key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    <span className="mr-1.5 inline-block size-3 rounded-full border align-[-1px]" style={{ backgroundColor: item.colorHex }} />
                    {item.productName}{" "}
                    <span className="font-normal text-muted-foreground">
                      · <b className="text-foreground">{item.sizeName}</b> / {item.colorName} × {item.qty}
                    </span>
                    {(item.fulfilment?.backorder ?? 0) > 0 ? (
                      <Badge variant="destructive" className="ml-1.5 align-middle">
                        Backorder
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{whereText(item)}</p>
                </div>
                {canAct && missing > 0 ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={() => setOpen({ action: "SUBSTITUTE", item })}>
                      <ArrowLeftRight />
                      Substitute
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setOpen({ action: "REMOVE_ITEM", item })}>
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
      {open ? (
        <ActionDialog
          key={`${open.action}:${open.item?.id ?? ""}`}
          order={order}
          action={open.action}
          item={open.item}
          canSettle={canSettle}
          wallets={wallets}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

const TITLES: Record<Action, string> = {
  SUBSTITUTE: "Substitute the missing item",
  WAIT: "Wait for stock",
  REMOVE_ITEM: "Remove the missing item",
  CANCEL: "Cancel for a stock-out",
};

function ActionDialog({
  order,
  action,
  item,
  canSettle,
  wallets,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  action: Action;
  item: OrderItemView | null;
  canSettle: boolean;
  wallets: WalletOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const missing = item ? item.qty - (item.fulfilment?.atHub ?? 0) : 0;
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState(String(missing || 1));
  const [expectedOn, setExpectedOn] = useState("");
  const [picked, setPicked] = useState<PickedVariant | null>(null);
  const [newQty, setNewQty] = useState(String(missing || 1));
  const [unitPrice, setUnitPrice] = useState("");
  const [lineDiscount, setLineDiscount] = useState("");
  // Set when the server says the customer has paid more than the new total.
  const [overpaid, setOverpaid] = useState<string | null>(null);
  const [settleKind, setSettleKind] = useState<"STORE_CREDIT" | "REFUND">("STORE_CREDIT");
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("BKASH");
  const [walletId, setWalletId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const settlement = overpaid ? (settleKind === "STORE_CREDIT" ? { kind: "STORE_CREDIT" } : { kind: "REFUND", method: refundMethod, walletId: walletId || null }) : null;
    const body =
      action === "WAIT"
        ? { action, reason, expectedOn: expectedOn || null }
        : action === "CANCEL"
          ? { action, reason, settlement }
          : action === "REMOVE_ITEM"
            ? { action, orderItemId: item!.id, qty: Number(qty), reason, settlement }
            : { action, orderItemId: item!.id, qty: Number(qty), variantId: picked?.variantId, newQty: Number(newQty), unitPrice: Number(unitPrice), lineDiscount: Number(lineDiscount || 0), reason, settlement };
    try {
      await fetchJson(`/api/orders/${order.id}/fulfilment`, { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && typeof err.body.overpaid === "string") setOverpaid(err.body.overpaid);
      else setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const refundWallets = walletsForMethod(wallets, refundMethod);
  const ready = reason.trim().length >= 3 && (action !== "SUBSTITUTE" || (picked !== null && unitPrice !== "")) && (!overpaid || settleKind === "STORE_CREDIT" || refundWallets.length > 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{TITLES[action]}</DialogTitle>
          <DialogDescription>
            {item ? (
              <>
                {item.productName} · {item.sizeName} / {item.colorName} — {missing} of {item.qty} not at the packing hub.{" "}
              </>
            ) : null}
            {action === "CANCEL"
              ? `${order.orderNo} is cancelled and every piece goes back to stock for the next order. It counts as a lost sale.`
              : action === "WAIT"
                ? "The order stays as it is and ships when the stock arrives."
                : action === "REMOVE_ITEM"
                  ? "The rest of the order ships. The total and due are recomputed and a new invoice version is made; the removed value counts as a lost sale."
                  : "Only after the customer agreed. The total and due are recomputed and a new invoice version is made."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {action === "SUBSTITUTE" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>Send instead</Label>
                {picked ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      {picked.productName} · <b>{picked.sizeName}</b> / {picked.colorName} <span className="font-mono text-xs text-muted-foreground">{picked.sku}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <OrderItemPicker
                    onPick={(v) => {
                      setPicked(v);
                      setUnitPrice(String(Number(v.effectivePrice)));
                    }}
                  />
                )}
                {item?.setLineId ? <p className="text-xs text-muted-foreground">A piece of an outfit set: pick another size or colour of the same product.</p> : null}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NumberField label="Replace (pcs)" value={qty} onChange={setQty} />
                <NumberField label="Send (pcs)" value={newQty} onChange={setNewQty} />
                <NumberField label="Unit price" value={unitPrice} onChange={setUnitPrice} decimal />
                <NumberField label="Discount" value={lineDiscount} onChange={setLineDiscount} decimal />
              </div>
            </>
          ) : null}
          {action === "REMOVE_ITEM" ? <NumberField label={`Remove (pcs, of ${item!.qty})`} value={qty} onChange={setQty} /> : null}
          {action === "WAIT" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expected-on">Expected date (optional)</Label>
              <Input id="expected-on" type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fulfil-reason">Reason</Label>
            <Textarea id="fulfil-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What the customer said (called on …)" rows={2} />
          </div>

          {overpaid ? (
            canSettle ? (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <p>
                  The customer has paid <b>{formatBDT(overpaid)}</b> more than the new total. How does it go back?
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={settleKind === "STORE_CREDIT" ? "default" : "outline"} onClick={() => setSettleKind("STORE_CREDIT")}>
                    Store credit (at once)
                  </Button>
                  <Button size="sm" variant={settleKind === "REFUND" ? "default" : "outline"} onClick={() => setSettleKind("REFUND")}>
                    Refund (needs approval)
                  </Button>
                </div>
                {settleKind === "REFUND" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select value={refundMethod} onValueChange={(v) => setRefundMethod(v as RefundMethod)}>
                      <SelectTrigger className="w-full">
                        <SelectValue>{(v: RefundMethod) => PAYMENT_METHOD_LABELS[v]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHOD_VALUES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {PAYMENT_METHOD_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {refundWallets.length > 1 ? (
                      <Select value={walletId} onValueChange={(v) => setWalletId(String(v))}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Paid from wallet">{(v: string) => refundWallets.find((w) => w.id === v)?.name ?? "Paid from wallet"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {refundWallets.map((w) => (
                            <SelectItem key={w.id} value={w.id}>
                              {w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : refundWallets.length === 0 ? (
                      <p className="text-xs">No active wallet pays out by {PAYMENT_METHOD_LABELS[refundMethod]}.</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-destructive">The customer has paid more than the new total — ask the sales executive to do this.</p>
            )
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button variant={action === "CANCEL" ? "destructive" : "default"} disabled={busy || !ready || (overpaid !== null && !canSettle)} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {action === "CANCEL" ? "Cancel the order" : action === "WAIT" ? "Keep waiting" : action === "REMOVE_ITEM" ? "Remove it" : "Substitute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ label, value, onChange, decimal = false }: { label: string; value: string; onChange: (v: string) => void; decimal?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input inputMode={decimal ? "decimal" : "numeric"} value={value} onChange={(e) => onChange(e.target.value.replace(decimal ? /[^\d.]/g : /\D/g, ""))} className="text-sm text-foreground tabular-nums" />
    </label>
  );
}
