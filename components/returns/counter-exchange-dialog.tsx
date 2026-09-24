"use client";

import { useEffect, useState } from "react";
import { Loader2, Printer, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ReplacementPicker, type Replacement } from "@/components/returns/replacement-picker";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS } from "@/lib/orders/constants";
import { POS_PAYMENT_METHODS, type PosPaymentMethod } from "@/lib/pos/constants";
import { RETURN_REASON_LABELS, RETURN_REASON_VALUES, type ReturnReasonValue } from "@/lib/returns/constants";
import type { CounterLookup } from "@/lib/returns/types";

type Quote = { returnedValue: string; replacementTotal: string; toPay: string; toRefund: string };
type Result = { replacementOrderId: string; replacementOrderNo: string; paid: string; change: string; refundRequested: string; restockedUnits: number; writtenOffUnits: number };
type Line = { qty: string; damaged: string; replacement: Replacement | null };

// PRD §4.11 B — the customer is at the counter with the item. Find the sale
// on their receipt, swap the size/colour, check the item on the spot, settle
// the difference. Stock moves both ways in one go; no courier, no approval
// (a refund for a cheaper replacement still needs a Manager/Admin).
export function CounterExchangeDialog({ initialOrderNo, onClose, onDone }: { initialOrderNo?: string; onClose: () => void; onDone?: () => void }) {
  const [orderNo, setOrderNo] = useState(initialOrderNo ?? "");
  const [order, setOrder] = useState<CounterLookup | null>(null);
  const [finding, setFinding] = useState(false);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [reason, setReason] = useState<ReturnReasonValue | "">("");
  const [reasonNote, setReasonNote] = useState("");
  // Keyed by the lines it priced, so a stale quote is never shown for changed lines.
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote | null; error: string | null } | null>(null);
  const [payMethod, setPayMethod] = useState<PosPaymentMethod>("CASH");
  const [tendered, setTendered] = useState("");
  const [trxId, setTrxId] = useState("");
  const [refundMethod, setRefundMethod] = useState<PosPaymentMethod>("CASH");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function find(no = orderNo) {
    if (!no.trim()) return;
    setFinding(true);
    setError(null);
    try {
      const { order: found } = await fetchJson<{ order: CounterLookup }>(`/api/returns/counter/lookup?orderNo=${encodeURIComponent(no.trim())}`);
      setOrder(found);
      const returnable = found.items.filter((i) => i.returnable > 0);
      setLines(Object.fromEntries(returnable.map((i) => [i.orderItemId, { qty: returnable.length === 1 ? "1" : "0", damaged: "0", replacement: null }])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not find that order.");
    } finally {
      setFinding(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount when opened from an order, no data-fetching lib in this project yet
    if (initialOrderNo) void find(initialOrderNo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = order ? order.items.filter((i) => Number(lines[i.orderItemId]?.qty) > 0) : [];
  const linesValid =
    chosen.length > 0 &&
    chosen.every((i) => {
      const l = lines[i.orderItemId];
      const q = Number(l.qty);
      const d = Number(l.damaged);
      return Number.isInteger(q) && q <= i.returnable && Number.isInteger(d) && d >= 0 && d <= q && l.replacement;
    });
  const quoteKey = linesValid && order ? JSON.stringify(chosen.map((i) => [i.orderItemId, lines[i.orderItemId].qty, lines[i.orderItemId].replacement!.variantId])) : null;

  // The server prices the swap exactly as the exchange will (same garment
  // keeps what was paid; another product sells at today's price).
  useEffect(() => {
    if (!quoteKey || !order) return;
    const timer = setTimeout(() => {
      fetchJson<{ quote: Quote }>("/api/returns/counter/quote", {
        method: "POST",
        body: JSON.stringify({ orderId: order.orderId, lines: (JSON.parse(quoteKey) as [string, string, string][]).map(([orderItemId, qty, replacementVariantId]) => ({ orderItemId, qty: Number(qty), replacementVariantId })) }),
      })
        .then(({ quote: q }) => setQuoted({ key: quoteKey, quote: q, error: null }))
        .catch((err) => setQuoted({ key: quoteKey, quote: null, error: err instanceof ApiError ? err.message : "Could not price the exchange." }));
    }, 250);
    return () => clearTimeout(timer);
  }, [quoteKey, order]);

  const quote = quoted && quoted.key === quoteKey ? quoted.quote : null;
  const quoteError = quoted && quoted.key === quoteKey ? quoted.error : null;
  const toPay = Number(quote?.toPay ?? 0);
  const toRefund = Number(quote?.toRefund ?? 0);
  const tenderInvalid = toPay > 0 && ((payMethod === "CASH" && tendered !== "" && Number(tendered) < toPay) || ((payMethod === "BKASH" || payMethod === "NAGAD") && !trxId.trim()));
  const invalid = !linesValid || !quote || !reason || (reason === "OTHER" && !reasonNote.trim()) || tenderInvalid;

  async function submit() {
    if (!order) return;
    setSaving(true);
    setError(null);
    try {
      const { result: r } = await fetchJson<{ result: Result }>("/api/returns/counter", {
        method: "POST",
        body: JSON.stringify({
          orderId: order.orderId,
          reason,
          reasonNote: reasonNote.trim() || null,
          lines: chosen.map((i) => {
            const l = lines[i.orderItemId];
            return { orderItemId: i.orderItemId, qty: Number(l.qty), replacementVariantId: l.replacement!.variantId, goodQty: Number(l.qty) - Number(l.damaged), damagedQty: Number(l.damaged) };
          }),
          tenders: toPay > 0 ? [{ method: payMethod, amount: toPay, tendered: payMethod === "CASH" && tendered ? Number(tendered) : null, transactionId: trxId.trim() || null }] : [],
          refundMethod: toRefund > 0 ? refundMethod : null,
        }),
      });
      setResult(r);
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not complete the exchange.");
    } finally {
      setSaving(false);
    }
  }

  const setLine = (id: string, patch: Partial<Line>) => setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Exchange at the counter</DialogTitle>
          <DialogDescription>Check the item in the customer&apos;s hand, swap it, and settle any difference now.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Done — replacement <b className="font-mono">{result.replacementOrderNo}</b>.{" "}
              {result.writtenOffUnits > 0 ? `${result.writtenOffUnits} damaged unit(s) written off; ` : ""}
              {result.restockedUnits > 0 ? `${result.restockedUnits} unit(s) back on the shelf.` : ""}
            </p>
            {Number(result.paid) > 0 ? (
              <p className="text-base">
                Took {formatBDT(result.paid)}
                {Number(result.change) > 0 ? (
                  <>
                    {" "}
                    · give change <b>{formatBDT(result.change)}</b>
                  </>
                ) : null}
              </p>
            ) : null}
            {Number(result.refundRequested) > 0 ? (
              <p className="text-base">
                Refund of <b>{formatBDT(result.refundRequested)}</b> sent for a Manager&apos;s approval — pay it out once approved.
              </p>
            ) : null}
          </div>
        ) : !order ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void find();
            }}
          >
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="cx-order">Order number on the receipt</Label>
              <Input id="cx-order" className="h-11 font-mono uppercase" autoFocus placeholder="AB-2609-0001" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} />
            </div>
            <Button type="submit" className="h-11" disabled={finding || !orderNo.trim()}>
              {finding ? <Loader2 className="size-4 animate-spin" /> : <Search />}
              Find
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <p>
              <b className="font-mono">{order.orderNo}</b> · {order.customerName} · {order.channel === "WALK_IN" ? "Walk-in" : "Online"} sale
              {!order.returnableStatus ? <span className="text-destructive"> — this order isn&apos;t with the customer yet, so it can&apos;t be exchanged.</span> : null}
            </p>
            {order.items.filter((i) => i.returnable > 0).length === 0 ? <p className="text-muted-foreground">Nothing on this order can be exchanged — it&apos;s all been returned already.</p> : null}
            {order.items
              .filter((i) => i.returnable > 0)
              .map((item) => {
                const l = lines[item.orderItemId];
                const q = Number(l?.qty ?? 0);
                return (
                  <div key={item.orderItemId} className="flex flex-col gap-2 rounded-md border p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span>
                        {item.product} <b>{item.size} / {item.color}</b> <span className="text-xs text-muted-foreground">· paid {formatBDT(item.paidPerUnit)} each</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`cx-q-${item.orderItemId}`} className="text-xs text-muted-foreground">
                          Back
                        </Label>
                        <Input id={`cx-q-${item.orderItemId}`} type="number" inputMode="numeric" min={0} max={item.returnable} className="h-10 w-16" value={l?.qty ?? "0"} onChange={(e) => setLine(item.orderItemId, { qty: e.target.value })} />
                        <span className="text-xs text-muted-foreground">of {item.returnable}</span>
                      </div>
                    </div>
                    {q > 0 ? (
                      <>
                        <ReplacementPicker productId={item.productId} currentVariantId={item.variantId} value={l.replacement} onChange={(r) => setLine(item.orderItemId, { replacement: r })} />
                        <div className="flex items-center gap-2">
                          <Label htmlFor={`cx-d-${item.orderItemId}`} className="text-xs">
                            Damaged
                          </Label>
                          <Input id={`cx-d-${item.orderItemId}`} type="number" inputMode="numeric" min={0} max={q} className="h-10 w-16" value={l.damaged} onChange={(e) => setLine(item.orderItemId, { damaged: e.target.value })} />
                          <span className="text-xs text-muted-foreground">
                            of {q} · {Math.max(0, q - Number(l.damaged || 0))} good go back on the shelf
                          </span>
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              })}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Reason</Label>
                <Select value={reason} onValueChange={(v) => setReason(v as ReturnReasonValue)}>
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue placeholder="Pick a reason">{(v: string) => (v ? RETURN_REASON_LABELS[v as ReturnReasonValue] : "Pick a reason")}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {RETURN_REASON_VALUES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {RETURN_REASON_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cx-note">{reason === "OTHER" ? "What happened" : "Note (optional)"}</Label>
                <Textarea id="cx-note" rows={1} value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} />
              </div>
            </div>

            {quoteError ? <p className="text-destructive">{quoteError}</p> : null}
            {quote ? (
              <div className="flex flex-col gap-3 rounded-md bg-muted/50 p-3">
                <p>
                  Coming back {formatBDT(quote.returnedValue)} · going out {formatBDT(quote.replacementTotal)} →{" "}
                  {toPay > 0 ? <b className="text-base">customer pays {formatBDT(toPay)}</b> : toRefund > 0 ? <b className="text-base">customer is owed {formatBDT(toRefund)}</b> : <b>no difference</b>}
                </p>
                {toPay > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label>Paid by</Label>
                      <Select value={payMethod} onValueChange={(v) => setPayMethod(v as PosPaymentMethod)}>
                        <SelectTrigger className="h-10">
                          <SelectValue>{(v: string) => PAYMENT_METHOD_LABELS[v as PosPaymentMethod]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {POS_PAYMENT_METHODS.map((m) => (
                            <SelectItem key={m} value={m}>
                              {PAYMENT_METHOD_LABELS[m]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {payMethod === "CASH" ? (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="cx-tendered">Cash handed over (for change)</Label>
                        <Input id="cx-tendered" type="number" inputMode="decimal" className="h-10" placeholder={String(toPay)} value={tendered} onChange={(e) => setTendered(e.target.value)} />
                      </div>
                    ) : payMethod === "BKASH" || payMethod === "NAGAD" ? (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="cx-trx">Transaction ID</Label>
                        <Input id="cx-trx" className="h-10 font-mono uppercase" value={trxId} onChange={(e) => setTrxId(e.target.value)} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {toRefund > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <Label>Refund by</Label>
                    <Select value={refundMethod} onValueChange={(v) => setRefundMethod(v as PosPaymentMethod)}>
                      <SelectTrigger className="h-10 sm:w-56">
                        <SelectValue>{(v: string) => PAYMENT_METHOD_LABELS[v as PosPaymentMethod]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {POS_PAYMENT_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {PAYMENT_METHOD_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">The refund waits for a Manager or Admin to approve it — every refund needs a second person.</p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          {result ? (
            <>
              <Button render={<a href={`/api/pos/sales/${result.replacementOrderId}/receipt`} target="_blank" rel="noreferrer" />} nativeButton={false} variant="outline" className="h-11">
                <Printer />
                Receipt
              </Button>
              <Button className="h-11" onClick={onClose}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" className="h-11" onClick={order && !initialOrderNo ? () => setOrder(null) : onClose} disabled={saving}>
                {order && !initialOrderNo ? "Another order" : "Cancel"}
              </Button>
              {order ? (
                <Button className="h-11" onClick={submit} disabled={saving || invalid || !order.returnableStatus}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Complete exchange
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
