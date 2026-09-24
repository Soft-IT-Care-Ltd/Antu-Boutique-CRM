"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ReplacementPicker, type Replacement } from "@/components/returns/replacement-picker";
import { ApiError, fetchJson } from "@/lib/orders/client";
import {
  COURIER_CHARGE_BEARER_LABELS,
  COURIER_CHARGE_BEARER_VALUES,
  RETURN_REASON_LABELS,
  RETURN_REASON_VALUES,
  type CourierChargeBearerValue,
  type ReturnReasonValue,
} from "@/lib/returns/constants";
import { RETURN_SETTLEMENT_LABELS, RETURN_SETTLEMENT_VALUES, type ReturnSettlementValue } from "@/lib/store-credit/constants";
import type { ReturnableItem } from "@/lib/returns/types";

// PRD §4.11 — asking for a return or an exchange on an order the customer
// has received. Nothing moves until a TL/Manager/Admin approves it, and
// stock only once the item is back and checked.
export function CaseRequestDialog({
  type,
  orderId,
  orderNo,
  items,
  onClose,
  onDone,
}: {
  type: "RETURN" | "EXCHANGE";
  orderId: string;
  orderNo: string;
  items: ReturnableItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const returnable = items.filter((i) => i.returnable > 0);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(returnable.map((i) => [i.orderItemId, returnable.length === 1 ? String(i.returnable) : "0"])));
  const [replacements, setReplacements] = useState<Record<string, Replacement | null>>({});
  const [reason, setReason] = useState<ReturnReasonValue | "">("");
  const [reasonNote, setReasonNote] = useState("");
  const [bearer, setBearer] = useState<CourierChargeBearerValue>("CUSTOMER");
  const [settlement, setSettlement] = useState<ReturnSettlementValue>("REFUND");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = returnable.filter((i) => Number(qty[i.orderItemId]) > 0);
  const qtyInvalid = returnable.some((i) => {
    const v = Number(qty[i.orderItemId]);
    return !Number.isInteger(v) || v < 0 || v > i.returnable;
  });
  const missingReplacement = type === "EXCHANGE" && chosen.some((i) => !replacements[i.orderItemId]);
  const invalid = chosen.length === 0 || qtyInvalid || !reason || (reason === "OTHER" && !reasonNote.trim()) || missingReplacement;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await fetchJson("/api/returns", {
        method: "POST",
        body: JSON.stringify({
          orderId,
          type,
          reason,
          reasonNote: reasonNote.trim() || null,
          courierChargeBearer: type === "EXCHANGE" ? bearer : null,
          settlement,
          lines: chosen.map((i) => ({ orderItemId: i.orderItemId, qty: Number(qty[i.orderItemId]), replacementVariantId: type === "EXCHANGE" ? replacements[i.orderItemId]!.variantId : null })),
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{type === "EXCHANGE" ? "Exchange by courier" : "Return for a refund"}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{orderNo}</span> —{" "}
            {type === "EXCHANGE"
              ? "The customer sends the item back; a linked replacement order ships through packing and the courier. A TL or Admin approves first."
              : "The customer sends the items back for a refund. A TL or Admin approves first; stock moves once Packing has checked them."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {returnable.map((item) => (
            <div key={item.orderItemId} className="flex flex-col gap-2 rounded-md border p-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={`rq-${item.orderItemId}`} className="flex-col items-start gap-0">
                  <span>
                    {item.product}
                    {item.setName ? <span className="font-normal text-muted-foreground"> · from set {item.setName}</span> : null}
                  </span>
                  <span className="text-xs font-semibold">
                    {item.size} / {item.color} · <span className="font-mono font-normal">{item.sku}</span>
                  </span>
                </Label>
                <div className="flex shrink-0 items-center gap-2 text-sm">
                  <Input
                    id={`rq-${item.orderItemId}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={item.returnable}
                    className="h-9 w-16"
                    value={qty[item.orderItemId] ?? ""}
                    onChange={(e) => setQty((prev) => ({ ...prev, [item.orderItemId]: e.target.value }))}
                  />
                  <span className="text-xs text-muted-foreground">of {item.returnable}</span>
                </div>
              </div>
              {type === "EXCHANGE" && Number(qty[item.orderItemId]) > 0 ? (
                <ReplacementPicker
                  productId={item.productId}
                  currentVariantId={item.variantId}
                  value={replacements[item.orderItemId] ?? null}
                  onChange={(r) => setReplacements((prev) => ({ ...prev, [item.orderItemId]: r }))}
                />
              ) : null}
            </div>
          ))}
          {items.some((i) => i.returnable === 0) ? (
            <p className="text-xs text-muted-foreground">Items already returned, or already in a request waiting for approval, aren&apos;t listed.</p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as ReturnReasonValue)}>
                <SelectTrigger className="h-9 w-full">
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
            {type === "EXCHANGE" ? (
              <div className="flex flex-col gap-1.5">
                <Label>Replacement delivery</Label>
                <Select value={bearer} onValueChange={(v) => setBearer(v as CourierChargeBearerValue)}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue>{(v: string) => COURIER_CHARGE_BEARER_LABELS[v as CourierChargeBearerValue]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {COURIER_CHARGE_BEARER_VALUES.map((b) => (
                      <SelectItem key={b} value={b}>
                        {COURIER_CHARGE_BEARER_LABELS[b]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{type === "EXCHANGE" ? "If the replacement costs less, the difference goes back as" : "Money goes back as"}</Label>
            <Select value={settlement} onValueChange={(v) => setSettlement(v as ReturnSettlementValue)}>
              <SelectTrigger className="h-9 w-full sm:w-72">
                <SelectValue>{(v: string) => RETURN_SETTLEMENT_LABELS[v as ReturnSettlementValue]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RETURN_SETTLEMENT_VALUES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {RETURN_SETTLEMENT_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {settlement === "STORE_CREDIT"
                ? "Credited to the customer's store credit once the item is back and checked — no cash goes out, no refund approval."
                : "Accounts requests the refund from the order's payments; a Manager or Admin approves it."}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rq-note">{reason === "OTHER" ? "What happened" : "Note (optional)"}</Label>
            <Textarea id="rq-note" rows={2} value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="e.g. customer says the chest is tight" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || invalid}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Send for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
