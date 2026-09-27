"use client";

import Link from "next/link";
import { useState } from "react";
import { Gift, Loader2, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatDhakaDate, formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { STORE_CREDIT_ENTRY_LABELS } from "@/lib/store-credit/constants";
import type { StoreCreditSummary } from "@/lib/store-credit/ledger";

// PRD §4.11 (P3.2) — the customer's store credit: balance (derived from the
// ledger, never stored) and every movement with its order, who and when.
// Only an Admin can adjust it, with a reason (audit-logged).
export function StoreCreditCard({ customerId, initial, canAdjust }: { customerId: string; initial: StoreCreditSummary; canAdjust: boolean }) {
  const [credit, setCredit] = useState(initial);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const signed = (direction === "add" ? 1 : -1) * Number(amount);
      const { storeCredit } = await fetchJson<{ storeCredit: StoreCreditSummary }>(`/api/customers/${customerId}/store-credit`, {
        method: "POST",
        body: JSON.stringify({ amount: signed, reason: reason.trim() }),
      });
      setCredit(storeCredit);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the adjustment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gift className="size-4" /> Store credit
          </CardTitle>
          <CardDescription>Owed to the customer — spent at the counter or on an online order by giving this phone number.</CardDescription>
        </div>
        {canAdjust ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDirection("add");
              setAmount("");
              setReason("");
              setError(null);
              setOpen(true);
            }}
          >
            <SlidersHorizontal />
            Adjust
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{formatBDT(credit.balance)}</p>
          {credit.expiring.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {credit.expiring.map((e) => `${formatBDT(e.amount)} expires ${formatDhakaDate(e.expiresAt)}`).join(" · ")}
            </p>
          ) : null}
        </div>

        {credit.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No store credit yet. It&apos;s issued when an exchange or return is settled as credit.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credit.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDhakaDateTime(e.at)}
                      <span className="block text-muted-foreground">{e.by ?? "System"}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      <Badge variant="outline">{STORE_CREDIT_ENTRY_LABELS[e.type]}</Badge>
                      {e.reason ? <span className="block text-xs text-muted-foreground">{e.reason}</span> : null}
                      {e.expiresAt ? <span className="block text-xs text-muted-foreground">Expires {formatDhakaDate(e.expiresAt)}</span> : null}
                    </TableCell>
                    <TableCell>
                      {e.order ? (
                        <Link href={`/orders/${e.order.id}`} className="font-mono text-xs hover:underline">
                          {e.order.orderNo}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${Number(e.amount) < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {Number(e.amount) > 0 ? "+" : "−"}
                      {formatBDT(String(Math.abs(Number(e.amount))))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust store credit</DialogTitle>
            <DialogDescription>Balance now {formatBDT(credit.balance)}. The reason is kept in the ledger and the audit log.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex overflow-hidden rounded-lg border self-start" role="group" aria-label="Add or take away">
              {(["add", "remove"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={direction === d}
                  className={`h-9 px-3 text-sm ${direction === d ? "bg-primary text-primary-foreground" : "bg-card"}`}
                  onClick={() => setDirection(d)}
                >
                  {d === "add" ? "Add credit" : "Take away"}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-amount">Amount (৳)</Label>
              <Input id="sc-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sc-reason">Reason (required)</Label>
              <Textarea id="sc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. goodwill for a late delivery" />
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={save} disabled={saving || !(Number(amount) > 0) || reason.trim().length < 3}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
