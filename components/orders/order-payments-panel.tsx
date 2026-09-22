"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES, PAYMENT_WALLET_SUGGESTIONS } from "@/lib/orders/constants";
import type { PaymentMethodValue } from "@/lib/orders/constants";
import type { OrderDetail, PaymentView } from "@/lib/orders/types";

function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type PaymentFormState = {
  amount: string;
  method: PaymentMethodValue;
  wallet: string;
  transactionId: string;
  paidAt: string;
  note: string;
};

function emptyForm(): PaymentFormState {
  return { amount: "", method: "BKASH", wallet: "", transactionId: "", paidAt: toDateInputValue(new Date().toISOString()), note: "" };
}

function formFromPayment(payment: PaymentView): PaymentFormState {
  return {
    amount: payment.amount,
    method: payment.method,
    wallet: payment.wallet ?? "",
    transactionId: payment.transactionId ?? "",
    paidAt: toDateInputValue(payment.paidAt),
    note: payment.note ?? "",
  };
}

// PRD §4.10 — record/edit/delete/verify payments against an order. Every
// mutation returns the full order (recomputed due_amount included), so this
// panel never derives due_amount itself — see lib/orders/totals.ts's
// recomputeOrderDueAmount, the only place allowed to produce that number.
export function OrderPaymentsPanel({
  order,
  onChange,
  canCreate,
  canEdit,
  canDelete,
  canVerify,
}: {
  order: OrderDetail;
  onChange: (order: OrderDetail) => void;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canVerify: boolean;
}) {
  const [dialogPayment, setDialogPayment] = useState<PaymentView | "new" | null>(null);
  const [form, setForm] = useState<PaymentFormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPaymentId, setBusyPaymentId] = useState<string | null>(null);

  function openCreate() {
    setForm(emptyForm());
    setError(null);
    setDialogPayment("new");
  }

  function openEdit(payment: PaymentView) {
    setForm(formFromPayment(payment));
    setError(null);
    setDialogPayment(payment);
  }

  async function submit() {
    const amountNum = Number(form.amount);
    if (!amountNum || amountNum <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        amount: amountNum,
        method: form.method,
        wallet: form.wallet.trim() || undefined,
        transactionId: form.transactionId.trim() || undefined,
        paidAt: form.paidAt ? new Date(form.paidAt).toISOString() : undefined,
        note: form.note.trim() || undefined,
      };
      const url =
        dialogPayment === "new" ? `/api/orders/${order.id}/payments` : `/api/orders/${order.id}/payments/${dialogPayment!.id}`;
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(url, {
        method: dialogPayment === "new" ? "POST" : "PATCH",
        body: JSON.stringify(body),
      });
      onChange(updated);
      setDialogPayment(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save payment.");
    } finally {
      setSaving(false);
    }
  }

  async function deletePayment(paymentId: string) {
    setBusyPaymentId(paymentId);
    setError(null);
    try {
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(`/api/orders/${order.id}/payments/${paymentId}`, {
        method: "DELETE",
      });
      onChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete payment.");
    } finally {
      setBusyPaymentId(null);
    }
  }

  async function verifyPayment(paymentId: string) {
    setBusyPaymentId(paymentId);
    setError(null);
    try {
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(`/api/orders/${order.id}/payments/${paymentId}/verify`, {
        method: "POST",
        body: JSON.stringify({ verified: true }),
      });
      onChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify payment.");
    } finally {
      setBusyPaymentId(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Payments</p>
        {canCreate ? (
          <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={openCreate}>
            <Plus className="size-3.5" />
            Record payment
          </Button>
        ) : null}
      </div>

      {order.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments recorded yet.</p> : null}

      {order.payments.map((payment) => (
        <div key={payment.id} className="flex items-center justify-between gap-2 text-sm">
          <div className="min-w-0">
            <span>
              {PAYMENT_METHOD_LABELS[payment.method]}
              {payment.wallet ? <span className="text-muted-foreground"> · {payment.wallet}</span> : null}
              {payment.transactionId ? <span className="ml-1 font-mono text-xs text-muted-foreground">#{payment.transactionId}</span> : null}
              {payment.verified ? (
                <Badge variant="outline" className="ml-1.5 gap-1 border-emerald-600/30 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="size-3" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="outline" className="ml-1.5">
                  Unverified
                </Badge>
              )}
            </span>
            <div className="text-xs text-muted-foreground">
              {formatDateTime(payment.paidAt)}
              {payment.receivedBy ? ` · ${payment.receivedBy.name}` : ""}
              {payment.note ? ` · ${payment.note}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="font-medium">{formatBDT(payment.amount)}</span>
            {canVerify && !payment.verified ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Verify payment"
                disabled={busyPaymentId === payment.id}
                onClick={() => verifyPayment(payment.id)}
              >
                {busyPaymentId === payment.id ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              </Button>
            ) : null}
            {canEdit ? (
              <Button type="button" variant="ghost" size="icon-sm" title="Edit payment" onClick={() => openEdit(payment)}>
                <Pencil />
              </Button>
            ) : null}
            {canDelete ? (
              <AlertDialog>
                <AlertDialogTrigger render={<Button type="button" variant="ghost" size="icon-sm" title="Delete payment" />}>
                  <Trash2 />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this payment?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes {formatBDT(payment.amount)} and recalculates the order&apos;s due amount. This can&apos;t be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deletePayment(payment.id)}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </div>
      ))}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Dialog open={dialogPayment !== null} onOpenChange={(open) => !open && setDialogPayment(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogPayment === "new" ? "Record payment" : "Edit payment"}</DialogTitle>
            <DialogDescription>Due amount is recalculated automatically from the order total and all payments.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Method</Label>
              <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v as PaymentMethodValue })}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: PaymentMethodValue) => PAYMENT_METHOD_LABELS[value]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHOD_VALUES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-amount">Amount (৳)</Label>
              <Input
                id="payment-amount"
                type="number"
                min={0}
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-wallet">Wallet</Label>
              <Input
                id="payment-wallet"
                list="payment-wallet-suggestions"
                value={form.wallet}
                onChange={(e) => setForm({ ...form, wallet: e.target.value })}
                placeholder="bKash Personal"
              />
              <datalist id="payment-wallet-suggestions">
                {PAYMENT_WALLET_SUGGESTIONS.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-txn">Transaction ID</Label>
              <Input id="payment-txn" value={form.transactionId} onChange={(e) => setForm({ ...form, transactionId: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-paid-at">Paid on</Label>
              <Input id="payment-paid-at" type="date" value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="payment-note">Note</Label>
              <Textarea id="payment-note" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {dialogPayment === "new" ? "Record payment" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
