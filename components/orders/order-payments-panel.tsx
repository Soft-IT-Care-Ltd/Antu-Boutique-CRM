"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Gift, Loader2, Lock, Pencil, Plus, Trash2, Undo2 } from "lucide-react";

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
import { WalletSelect } from "@/components/wallets/wallet-select";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import type { PaymentMethodValue } from "@/lib/orders/constants";
import type { OrderDetail, PaymentView } from "@/lib/orders/types";
import { REFUND_STATUS_LABELS } from "@/lib/payments/types";
import { walletsForMethod, type WalletOption } from "@/lib/wallets/constants";

function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" });
}

type HandMethod = (typeof PAYMENT_METHOD_VALUES)[number];

type PaymentFormState = {
  amount: string;
  method: HandMethod;
  walletId: string;
  transactionId: string;
  paidAt: string;
  note: string;
};

const firstWallet = (wallets: WalletOption[], method: PaymentMethodValue) => walletsForMethod(wallets, method)[0]?.id ?? "";

// PRD §4.10 — record/edit/delete/verify payments against an order, and
// request/approve refunds. Every mutation returns the full order (recomputed
// due_amount included), so this panel never derives due_amount itself — see
// lib/orders/totals.ts's recomputeOrderDueAmount, the only place allowed to
// produce that number.
export function OrderPaymentsPanel({
  order,
  onChange,
  canCreate,
  canEdit,
  canDelete,
  canVerify,
  canRequestRefund,
  canDecideRefund,
  wallets,
  currentUserId,
}: {
  order: OrderDetail;
  onChange: (order: OrderDetail) => void;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canVerify: boolean;
  canRequestRefund: boolean;
  canDecideRefund: boolean;
  wallets: WalletOption[];
  currentUserId: string;
}) {
  const emptyForm = (): PaymentFormState => ({
    amount: "",
    method: "BKASH",
    walletId: firstWallet(wallets, "BKASH"),
    transactionId: "",
    paidAt: toDateInputValue(new Date().toISOString()),
    note: "",
  });

  const [dialog, setDialog] = useState<{ mode: "new" | "refund" } | { mode: "edit"; payment: PaymentView } | null>(null);
  const [form, setForm] = useState<PaymentFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPaymentId, setBusyPaymentId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<PaymentView | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  // P3.2 — the customer's store credit, to pay part of this order with it.
  const [creditBalance, setCreditBalance] = useState<string | null>(null);
  const [creditDialog, setCreditDialog] = useState<"use" | "giveBack" | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditNote, setCreditNote] = useState("");
  const customerPhone = order.customer?.phone ?? null;

  useEffect(() => {
    if (!canCreate || !customerPhone) return;
    let live = true;
    fetchJson<{ known: boolean; balance: string }>(`/api/store-credit/lookup?phone=${encodeURIComponent(customerPhone)}`)
      .then((r) => live && setCreditBalance(r.balance))
      .catch(() => live && setCreditBalance(null));
    return () => {
      live = false;
    };
  }, [canCreate, customerPhone, order.payments.length]);

  async function submitCredit() {
    setSaving(true);
    setError(null);
    try {
      const [url, body] =
        creditDialog === "use"
          ? [`/api/orders/${order.id}/payments`, { method: "STORE_CREDIT", amount: Number(creditAmount), note: creditNote.trim() || undefined }]
          : [`/api/orders/${order.id}/store-credit`, { reason: creditNote.trim() }];
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(url, { method: "POST", body: JSON.stringify(body) });
      onChange(updated);
      setCreditDialog(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function open(mode: "new" | "refund") {
    setForm(emptyForm());
    setError(null);
    setDialog({ mode });
  }

  function openEdit(payment: PaymentView) {
    setForm({
      amount: payment.amount,
      method: payment.method === "COURIER_COD" || payment.method === "EXCHANGE_CREDIT" || payment.method === "STORE_CREDIT" ? "CASH" : payment.method,
      walletId: payment.walletId ?? "",
      transactionId: payment.transactionId ?? "",
      paidAt: toDateInputValue(payment.paidAt),
      note: payment.note ?? "",
    });
    setError(null);
    setDialog({ mode: "edit", payment });
  }

  function setMethod(method: HandMethod) {
    // Keep the wallet if it still fits the new method, else pick the first that does.
    const keep = walletsForMethod(wallets, method).some((w) => w.id === form.walletId);
    setForm({ ...form, method, walletId: keep ? form.walletId : firstWallet(wallets, method) });
  }

  async function submit() {
    if (!dialog) return;
    const amountNum = Number(form.amount);
    if (!amountNum || amountNum <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (dialog.mode === "refund" && form.note.trim().length < 3) {
      setError("Give the reason for the refund.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const common = {
        amount: amountNum,
        method: form.method,
        walletId: form.walletId || undefined,
        transactionId: form.transactionId.trim() || undefined,
        paidAt: form.paidAt ? new Date(form.paidAt).toISOString() : undefined,
      };
      let request: [string, string, unknown];
      if (dialog.mode === "edit") request = [`/api/orders/${order.id}/payments/${dialog.payment.id}`, "PATCH", { ...common, note: form.note.trim() || undefined }];
      else if (dialog.mode === "refund") request = [`/api/orders/${order.id}/refunds`, "POST", { ...common, reason: form.note.trim() }];
      else request = [`/api/orders/${order.id}/payments`, "POST", { ...common, note: form.note.trim() || undefined }];
      const [url, method, body] = request;
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(url, { method, body: JSON.stringify(body) });
      onChange(updated);
      setDialog(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function act(paymentId: string, url: string, init: RequestInit, fallback: string) {
    setBusyPaymentId(paymentId);
    setError(null);
    try {
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(url, init);
      onChange(updated);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
      return false;
    } finally {
      setBusyPaymentId(null);
    }
  }

  const deletePayment = (id: string) => act(id, `/api/orders/${order.id}/payments/${id}`, { method: "DELETE" }, "Could not delete payment.");
  const verifyPayment = (id: string) =>
    act(id, `/api/orders/${order.id}/payments/${id}/verify`, { method: "POST", body: JSON.stringify({ verified: true }) }, "Could not verify payment.");
  const decide = (id: string, decision: "APPROVE" | "REJECT", note?: string) =>
    act(id, `/api/payments/${id}/refund-decision`, { method: "POST", body: JSON.stringify({ decision, note }) }, "Could not record the decision.");

  const methodWallets = walletsForMethod(wallets, form.method);
  const isRefundDialog = dialog?.mode === "refund";

  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Payments</p>
        <div className="flex gap-1">
          {canRequestRefund ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => open("refund")}>
              <Undo2 className="size-3.5" />
              Refund
            </Button>
          ) : null}
          {canCreate && creditBalance && Number(creditBalance) > 0 && Number(order.dueAmount) > 0 && order.status !== "CANCELLED" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-xs"
              onClick={() => {
                setCreditAmount(String(Math.min(Number(creditBalance), Number(order.dueAmount))));
                setCreditNote("");
                setError(null);
                setCreditDialog("use");
              }}
            >
              <Gift className="size-3.5" />
              Use store credit ({formatBDT(creditBalance)})
            </Button>
          ) : null}
          {canCreate ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => open("new")}>
              <Plus className="size-3.5" />
              Record payment
            </Button>
          ) : null}
        </div>
      </div>

      {order.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments recorded yet.</p> : null}

      {order.payments.map((payment) => {
        const isRefund = payment.kind === "REFUND";
        // Exchange and store credit move no money: nothing to verify, edit or delete by hand.
        const isCredit = payment.kind === "EXCHANGE_CREDIT" || payment.kind === "STORE_CREDIT";
        const locked = payment.fromCourierStatement || isCredit;
        const pendingRefund = isRefund && payment.refundStatus === "PENDING";
        const canDecideThis = canDecideRefund && pendingRefund && payment.receivedBy?.id !== currentUserId;
        return (
          <div key={payment.id} className={`flex items-start justify-between gap-2 text-sm ${isRefund && payment.refundStatus === "REJECTED" ? "opacity-60" : ""}`}>
            <div className="min-w-0">
              <span>
                {isRefund ? "Refund · " : ""}
                {PAYMENT_METHOD_LABELS[payment.method]}
                {payment.walletName ? <span className="text-muted-foreground"> · {payment.walletName}</span> : null}
                {payment.transactionId ? <span className="ml-1 font-mono text-xs text-muted-foreground">#{payment.transactionId}</span> : null}
                {isRefund ? (
                  <Badge
                    variant="outline"
                    className={`ml-1.5 ${payment.refundStatus === "APPROVED" ? "border-emerald-600/30 text-emerald-700 dark:text-emerald-400" : payment.refundStatus === "PENDING" ? "border-amber-500/40 text-amber-700 dark:text-amber-400" : ""}`}
                  >
                    {REFUND_STATUS_LABELS[payment.refundStatus ?? "PENDING"]}
                  </Badge>
                ) : isCredit ? (
                  <Badge variant="outline" className="ml-1.5">
                    {payment.kind === "STORE_CREDIT" ? (Number(payment.amount) > 0 ? "Spent from credit" : "To store credit") : "Moved with exchange"}
                  </Badge>
                ) : payment.verified ? (
                  <Badge variant="outline" className="ml-1.5 gap-1 border-emerald-600/30 text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" />
                    Verified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-1.5">
                    Unverified
                  </Badge>
                )}
                {payment.fromCourierStatement ? <Lock className="ml-1 inline size-3 text-muted-foreground" aria-label="From a courier statement" /> : null}
              </span>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(payment.paidAt)}
                {payment.receivedBy ? ` · ${isRefund ? "asked by " : ""}${payment.receivedBy.name}` : ""}
                {payment.verifiedBy && !isRefund ? ` · verified by ${payment.verifiedBy.name}` : ""}
                {payment.decidedBy ? ` · ${payment.refundStatus === "APPROVED" ? "approved" : "rejected"} by ${payment.decidedBy.name}` : ""}
                {payment.note ? ` · ${payment.note}` : ""}
              </div>
              {isRefund ? (
                <div className="text-xs">
                  <span className="text-muted-foreground">Reason:</span> {payment.refundReason}
                  {payment.decisionNote ? <span className="text-muted-foreground"> · {payment.decisionNote}</span> : null}
                </div>
              ) : null}
              {pendingRefund && canDecideRefund && !canDecideThis ? <div className="text-xs text-muted-foreground">Someone else has to approve a refund you asked for.</div> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span className={`font-medium tabular-nums ${isRefund ? "text-destructive" : ""}`}>{formatBDT(payment.amount)}</span>
              {canDecideThis ? (
                <>
                  <Button type="button" size="sm" variant="outline" className="h-7" disabled={busyPaymentId === payment.id} onClick={() => decide(payment.id, "APPROVE")}>
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    disabled={busyPaymentId === payment.id}
                    onClick={() => {
                      setRejectNote("");
                      setRejecting(payment);
                    }}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {payment.kind === "STORE_CREDIT" && Number(payment.amount) > 0 && canEdit && order.status !== "CANCELLED" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-xs"
                  title="Give the credit spent on this order back to the customer"
                  onClick={() => {
                    setCreditNote("");
                    setError(null);
                    setCreditDialog("giveBack");
                  }}
                >
                  Give back
                </Button>
              ) : null}
              {!isRefund && !isCredit && canVerify && !payment.verified ? (
                <Button type="button" variant="ghost" size="icon-sm" title="Verify payment" disabled={busyPaymentId === payment.id} onClick={() => verifyPayment(payment.id)}>
                  {busyPaymentId === payment.id ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                </Button>
              ) : null}
              {!isRefund && !locked && canEdit ? (
                <Button type="button" variant="ghost" size="icon-sm" title="Edit payment" onClick={() => openEdit(payment)}>
                  <Pencil />
                </Button>
              ) : null}
              {!isRefund && !locked && canDelete ? (
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
        );
      })}

      {error && !dialog && !rejecting && !creditDialog ? <p className="text-sm text-destructive">{error}</p> : null}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.mode === "new" ? "Record payment" : dialog?.mode === "refund" ? "Request a refund" : "Edit payment"}</DialogTitle>
            <DialogDescription>
              {isRefundDialog
                ? "Money going back to the customer. It needs a Manager or Admin to approve it before it counts."
                : dialog?.mode === "edit" && dialog.payment.verified
                  ? "Changing the amount, method, wallet or transaction ID sends this payment back to Accounts for verification."
                  : "Due amount is recalculated automatically from the order total and all payments."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Method</Label>
              <Select value={form.method} onValueChange={(v) => setMethod(v as HandMethod)}>
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
              <Input id="payment-amount" type="number" min={0} step="0.01" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-wallet">{isRefundDialog ? "Paid out of" : "Received into"}</Label>
              {methodWallets.length > 0 ? (
                <WalletSelect id="payment-wallet" wallets={methodWallets} value={form.walletId} onChange={(walletId) => setForm({ ...form, walletId })} />
              ) : (
                <p className="text-sm text-muted-foreground">No active {PAYMENT_METHOD_LABELS[form.method]} wallet.</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-txn">Transaction ID</Label>
              <Input id="payment-txn" value={form.transactionId} onChange={(e) => setForm({ ...form, transactionId: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-paid-at">{isRefundDialog ? "Refund date" : "Paid on"}</Label>
              <Input id="payment-paid-at" type="date" value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="payment-note">{isRefundDialog ? "Reason (required)" : "Note"}</Label>
              <Textarea id="payment-note" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {dialog?.mode === "new" ? "Record payment" : isRefundDialog ? "Request refund" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creditDialog !== null} onOpenChange={(o) => !o && setCreditDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{creditDialog === "use" ? "Pay from store credit" : "Give store credit back"}</DialogTitle>
            <DialogDescription>
              {creditDialog === "use"
                ? `The customer has ${formatBDT(creditBalance ?? "0")} of store credit. No money moves — it comes off their balance and counts as paid here.`
                : "Returns the store credit spent on this order to the customer's balance — e.g. if it was used by mistake. The order's due amount goes back up by the same."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {creditDialog === "use" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="credit-amount">Amount (৳)</Label>
                <Input id="credit-amount" type="number" min={0} step="0.01" inputMode="decimal" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} />
                <p className="text-xs text-muted-foreground">Up to {formatBDT(String(Math.min(Number(creditBalance ?? 0), Number(order.dueAmount))))} — the balance or what&apos;s due, whichever is less.</p>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="credit-note">{creditDialog === "use" ? "Note" : "Why (required)"}</Label>
              <Textarea id="credit-note" rows={2} value={creditNote} onChange={(e) => setCreditNote(e.target.value)} />
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={submitCredit} disabled={saving || (creditDialog === "use" ? !(Number(creditAmount) > 0) : creditNote.trim().length < 3)}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {creditDialog === "use" ? "Pay from credit" : "Give back"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this refund?</DialogTitle>
            <DialogDescription>{rejecting ? `${formatBDT(rejecting.amount)} — ${rejecting.refundReason}` : null}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reject-note">Why (required)</Label>
            <Textarea id="reject-note" rows={2} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={!rejectNote.trim() || busyPaymentId !== null}
              onClick={async () => {
                if (rejecting && (await decide(rejecting.id, "REJECT", rejectNote.trim()))) setRejecting(null);
              }}
            >
              Reject refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
