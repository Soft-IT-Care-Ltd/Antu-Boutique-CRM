"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCheck, CheckCircle2, ChevronLeft, ChevronRight, Inbox, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { WalletSelect } from "@/components/wallets/wallet-select";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ALL_PAYMENT_METHOD_VALUES, PAYMENT_METHOD_LABELS, type PaymentMethodValue } from "@/lib/orders/constants";
import { REFUND_STATUS_LABELS, REFUND_STATUS_VALUES, type PaymentListItem, type PaymentListView, type RefundStatusValue } from "@/lib/payments/types";
import type { WalletOption } from "@/lib/wallets/constants";

const PAGE_SIZE = 25;

type ListResponse = { items: PaymentListItem[]; total: number; totalAmount: string; counts: { unverified: number; unverifiedAmount: string; pendingRefunds: number } };

const EMPTY: Record<PaymentListView, { title: string; body: string }> = {
  unverified: { title: "Nothing waiting for verification", body: "New payments recorded by sales show up here until Accounts checks them against the wallet." },
  verified: { title: "No verified payments", body: "Try a wider date range." },
  refunds: { title: "No refunds", body: "Refunds are requested from an order's payments panel." },
  all: { title: "No payments found", body: "Try a wider date range or clear the filters." },
};

/**
 * PRD §4.10 — the Accounts verification queue (oldest first, bulk verify),
 * refunds awaiting approval, and payment history. Money is only counted in
 * a wallet's balance once verified (payments) or approved (refunds).
 */
export function PaymentList({ view, wallets, canVerify, canDecideRefund }: { view: PaymentListView; wallets: WalletOption[]; canVerify: boolean; canDecideRefund: boolean }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [method, setMethod] = useState<PaymentMethodValue | "all">("all");
  const [walletId, setWalletId] = useState("");
  const [refundStatus, setRefundStatus] = useState<RefundStatusValue | "all">(view === "refunds" ? "PENDING" : "all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<PaymentListItem | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ view, page: String(page), pageSize: String(PAGE_SIZE) });
    if (debouncedQ) params.set("q", debouncedQ);
    if (method !== "all") params.set("method", method);
    if (walletId) params.set("walletId", walletId);
    if (view === "refunds" && refundStatus !== "all") params.set("refundStatus", refundStatus);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    fetchJson<ListResponse>(`/api/payments?${params.toString()}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load payments."));
  }, [view, page, debouncedQ, method, walletId, refundStatus, from, to]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  function filter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
    setSelected(new Set());
  }

  async function verify(ids: string[]) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const { verified } = await fetchJson<{ verified: number }>("/api/payments/verify", { method: "POST", body: JSON.stringify({ paymentIds: ids }) });
      setNotice(`${verified} payment${verified === 1 ? "" : "s"} verified.`);
      setSelected(new Set());
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(item: PaymentListItem, decision: "APPROVE" | "REJECT", note?: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await fetchJson(`/api/payments/${item.id}/refund-decision`, { method: "POST", body: JSON.stringify({ decision, note }) });
      setNotice(`Refund on ${item.order.orderNo} ${decision === "APPROVE" ? "approved" : "rejected"}.`);
      setRejecting(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the decision.");
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items ?? null;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const selectable = view === "unverified" && canVerify;
  const selectedSum = items?.filter((i) => selected.has(i.id)).reduce((a, i) => a + Number(i.amount), 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {data && view === "unverified" ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{data.counts.unverified}</span> awaiting verification · <span className="font-medium text-foreground">{formatBDT(data.counts.unverifiedAmount)}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative lg:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Order no., TrxID, phone, name..." value={q} onChange={(e) => filter(setQ, e.target.value)} className="pl-8" />
        </div>
        <div className="grid grid-cols-2 gap-2 lg:flex">
          <Select value={method} onValueChange={(v) => filter(setMethod, v as PaymentMethodValue | "all")}>
            <SelectTrigger className="w-full lg:w-40">
              <SelectValue>{(v: string) => (v === "all" ? "All methods" : PAYMENT_METHOD_LABELS[v as PaymentMethodValue])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All methods</SelectItem>
              {ALL_PAYMENT_METHOD_VALUES.map((m) => (
                <SelectItem key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <WalletSelect wallets={wallets} value={walletId} onChange={(v) => filter(setWalletId, v)} allowAll className="w-full lg:w-48" />
          {view === "refunds" ? (
            <Select value={refundStatus} onValueChange={(v) => filter(setRefundStatus, v as RefundStatusValue | "all")}>
              <SelectTrigger className="w-full lg:w-44">
                <SelectValue>{(v: string) => (v === "all" ? "Any status" : REFUND_STATUS_LABELS[v as RefundStatusValue])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                {REFUND_STATUS_VALUES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {REFUND_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" aria-label="From date" value={from} onChange={(e) => filter(setFrom, e.target.value)} />
          <Input type="date" aria-label="To date" value={to} onChange={(e) => filter(setTo, e.target.value)} />
        </div>
        {selectable && selected.size > 0 ? (
          <Button onClick={() => verify([...selected])} disabled={busy} className="lg:ml-auto">
            {busy ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            Verify {selected.size} · {formatBDT(selectedSum)}
          </Button>
        ) : null}
      </div>

      {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Inbox className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{EMPTY[view].title}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{EMPTY[view].body}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select all on this page"
                    checked={items.length > 0 && items.every((i) => selected.has(i.id))}
                    onCheckedChange={(checked) => setSelected(checked ? new Set(items.map((i) => i.id)) : new Set())}
                  />
                </TableHead>
              ) : null}
              <TableHead>Paid</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Method · wallet</TableHead>
              <TableHead>TrxID</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>{view === "refunds" ? "Refund" : "Status"}</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id}>
                {selectable ? (
                  <TableCell>
                    <Checkbox
                      aria-label={`Select payment on ${p.order.orderNo}`}
                      checked={selected.has(p.id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected);
                        if (checked) next.add(p.id);
                        else next.delete(p.id);
                        setSelected(next);
                      }}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="whitespace-nowrap text-sm">
                  {formatDhakaDateTime(p.paidAt)}
                  {p.receivedByName ? <div className="text-xs text-muted-foreground">{p.kind === "REFUND" ? "asked by" : "by"} {p.receivedByName}</div> : null}
                </TableCell>
                <TableCell>
                  <Link href={`/orders/${p.order.id}`} className="font-mono text-sm font-medium hover:underline">
                    {p.order.orderNo}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {p.order.customerName} · {p.order.customerPhone}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {PAYMENT_METHOD_LABELS[p.method]}
                  <div className="text-xs text-muted-foreground">{p.walletName ?? (p.method === "COURIER_COD" ? "via courier payout" : "—")}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">{p.transactionId ?? "—"}</TableCell>
                <TableCell className={`text-right font-medium tabular-nums ${p.kind === "REFUND" ? "text-destructive" : ""}`}>{formatBDT(p.amount)}</TableCell>
                <TableCell className="max-w-64 text-sm">
                  {p.kind === "REFUND" ? (
                    <>
                      <Badge variant="outline" className={p.refundStatus === "PENDING" ? "border-amber-500/40 text-amber-700 dark:text-amber-400" : p.refundStatus === "APPROVED" ? "border-emerald-600/30 text-emerald-700 dark:text-emerald-400" : ""}>
                        {REFUND_STATUS_LABELS[p.refundStatus ?? "PENDING"]}
                      </Badge>
                      <div className="mt-0.5 text-xs text-muted-foreground">{p.refundReason}</div>
                      {p.decidedByName ? (
                        <div className="text-xs text-muted-foreground">
                          by {p.decidedByName}
                          {p.decisionNote ? ` — ${p.decisionNote}` : ""}
                        </div>
                      ) : null}
                    </>
                  ) : p.verified ? (
                    <span className="text-xs text-muted-foreground">
                      <CheckCircle2 className="mr-1 inline size-3 text-emerald-600" />
                      {p.verifiedByName ? `Verified by ${p.verifiedByName}` : "Verified"}
                    </span>
                  ) : (
                    <Badge variant="outline">Unverified</Badge>
                  )}
                  {p.note ? <div className="text-xs text-muted-foreground">{p.note}</div> : null}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {p.kind === "PAYMENT" && !p.verified && canVerify ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => verify([p.id])}>
                      Verify
                    </Button>
                  ) : null}
                  {p.canDecide && canDecideRefund ? (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(p, "APPROVE")}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setRejectNote("");
                          setRejecting(p);
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {data!.total} rows · {formatBDT(data!.totalAmount)}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this refund?</DialogTitle>
            <DialogDescription>{rejecting ? `${rejecting.order.orderNo} · ${formatBDT(rejecting.amount)} — ${rejecting.refundReason}` : null}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="list-reject-note">Why (required)</Label>
            <Textarea id="list-reject-note" rows={2} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={!rejectNote.trim() || busy} onClick={() => rejecting && decide(rejecting, "REJECT", rejectNote.trim())}>
              Reject refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
