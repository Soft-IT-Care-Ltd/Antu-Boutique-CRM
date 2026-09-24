"use client";

import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Lock, LockOpen } from "lucide-react";

import { countValue, DenominationCounter, EMPTY_COUNT, type CountState } from "@/components/pos/denomination-counter";
import { DrawerReconciliation } from "@/components/pos/drawer-reconciliation";
import { WalletSelect } from "@/components/wallets/wallet-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ExpenseCategoryOption } from "@/lib/expenses/constants";
import { formatDhakaDate } from "@/lib/inventory/constants";
import { toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { DRAWER_MOVEMENT_KINDS, DRAWER_MOVEMENT_LABELS, type DrawerMovementKind } from "@/lib/pos/constants";
import type { DrawerState, DrawerSummary } from "@/lib/pos/types";
import type { WalletOption } from "@/lib/wallets/constants";

const dayLabel = (ymd: string) => formatDhakaDate(`${ymd}T00:00:00+06:00`);

/**
 * PRD §4.7 — the daily cash drawer: open with a count, record cash in/out
 * during the day, count and close at day end. The close verifies the day's
 * cash payments and posts any difference once (lib/pos/drawer.ts).
 */
export function DrawerPanel({
  initial,
  canManage,
  wallets,
  categories,
}: {
  initial: DrawerState;
  canManage: boolean;
  wallets: WalletOption[];
  categories: ExpenseCategoryOption[];
}) {
  const [state, setState] = useState(initial);
  const [count, setCount] = useState<CountState>(EMPTY_COUNT);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [moving, setMoving] = useState(false);

  const drawer = state.drawer;
  const staleOpen = drawer && drawer.status === "OPEN" && drawer.businessDay !== state.today;

  function applyDrawer(next: DrawerSummary) {
    setState((s) => ({ ...s, drawer: next.businessDay === s.today || next.status === "OPEN" ? next : null }));
    if (next.status === "CLOSED" && next.businessDay !== state.today) {
      // Yesterday's drawer just closed: today's can open now.
      fetchJson<{ state: DrawerState }>("/api/pos/drawer")
        .then((d) => setState(d.state))
        .catch(() => {});
    }
  }

  async function open() {
    const { amount, denominations } = countValue(count);
    if (amount === null) return setError("Count the cash first.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<{ drawer: DrawerSummary }>("/api/pos/drawer", { method: "POST", body: JSON.stringify({ openingCount: amount, denominations, note: note.trim() || null }) });
      applyDrawer(res.drawer);
      setCount(EMPTY_COUNT);
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the drawer.");
    } finally {
      setBusy(false);
    }
  }

  if (!drawer) {
    const differsFromLast = state.lastClosingCount !== null && countValue(count).amount !== null && toPaisa(countValue(count).amount!) !== toPaisa(state.lastClosingCount);
    return (
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockOpen className="size-5" /> Open today&apos;s drawer
          </CardTitle>
          <CardDescription>
            {dayLabel(state.today)} · {state.walletName}.{" "}
            {state.lastClosingCount !== null ? (
              <>
                Last counted close ({state.lastClosedDay ? dayLabel(state.lastClosedDay) : ""}): <b>{formatBDT(state.lastClosingCount)}</b>.
              </>
            ) : (
              "This is the first drawer — count what's in it."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canManage ? (
            <>
              <DenominationCounter value={count} onChange={setCount} />
              {differsFromLast ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="open-note">Why is it different from the last close?</Label>
                  <Textarea id="open-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. owner added ৳2,000 change this morning" />
                </div>
              ) : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button className="h-12 text-base" disabled={busy} onClick={() => void open()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                Open the drawer
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">The drawer hasn&apos;t been opened today.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {staleOpen ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          The drawer for <b>{dayLabel(drawer.businessDay)}</b> was never closed. Count it and close it — today&apos;s drawer can open after that.
        </p>
      ) : null}

      {canManage && drawer.status === "OPEN" ? (
        <div className="flex flex-wrap gap-2">
          {!staleOpen ? (
            <Button variant="outline" className="h-11" onClick={() => setMoving(true)}>
              <ArrowUpFromLine />
              Cash in / out
            </Button>
          ) : null}
          <Button className="h-11" onClick={() => setClosing(true)}>
            <Lock />
            Count &amp; close
          </Button>
        </div>
      ) : null}
      {error && !closing && !moving ? <p className="text-sm text-destructive">{error}</p> : null}

      <DrawerReconciliation drawer={drawer} />

      <CloseDialog drawer={drawer} open={closing} onOpenChange={setClosing} onClosed={(d) => applyDrawer(d)} />
      <MovementDialog open={moving} onOpenChange={setMoving} wallets={wallets.filter((w) => w.id !== drawer.walletId)} categories={categories} expected={drawer.expectedClose} onDone={(d) => applyDrawer(d)} />
    </div>
  );
}

function CloseDialog({ drawer, open, onOpenChange, onClosed }: { drawer: DrawerSummary; open: boolean; onOpenChange: (open: boolean) => void; onClosed: (d: DrawerSummary) => void }) {
  const [count, setCount] = useState<CountState>(EMPTY_COUNT);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { amount, denominations } = countValue(count);
  const diff = amount === null ? null : toPaisa(amount) - toPaisa(drawer.expectedClose);

  async function close() {
    if (amount === null) return setError("Count the cash first.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<{ drawer: DrawerSummary }>("/api/pos/drawer/close", { method: "POST", body: JSON.stringify({ drawerId: drawer.id, closingCount: amount, denominations, note: note.trim() || null }) });
      onClosed(res.drawer);
      onOpenChange(false);
      setCount(EMPTY_COUNT);
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close the drawer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Count &amp; close — {dayLabel(drawer.businessDay)}</DialogTitle>
          <DialogDescription>
            Count every note and coin in the drawer. The drawer should hold <b>{formatBDT(drawer.expectedClose)}</b>.
            {drawer.totals.unverifiedCount > 0 ? ` Closing verifies ${drawer.totals.unverifiedCount} cash payment${drawer.totals.unverifiedCount === 1 ? "" : "s"} (${formatBDT(drawer.totals.unverified)}).` : ""}
          </DialogDescription>
        </DialogHeader>
        <DenominationCounter value={count} onChange={setCount} />
        {diff !== null ? (
          <div className={`flex items-center justify-between rounded-lg px-3 py-2 ${diff === 0 ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-destructive/10 text-destructive"}`}>
            <span className="text-sm">{diff === 0 ? "Matches exactly" : diff < 0 ? "Short" : "Over"}</span>
            <span className="text-lg font-semibold tabular-nums">{diff === 0 ? "✓" : formatBDT(Math.abs(diff) / 100)}</span>
          </div>
        ) : null}
        {diff !== null && diff !== 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="close-note">What happened? (required)</Label>
            <Textarea id="close-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. gave ৳50 too much change on a sale" />
            <p className="text-xs text-muted-foreground">The difference is posted once to the Cash over/short expense heading.</p>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={() => onOpenChange(false)}>
            Keep counting later
          </Button>
          <Button className="h-11" disabled={busy || amount === null || (diff !== 0 && !note.trim())} onClick={() => void close()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Close the drawer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementDialog({
  open,
  onOpenChange,
  wallets,
  categories,
  expected,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wallets: WalletOption[];
  categories: ExpenseCategoryOption[];
  expected: string;
  onDone: (d: DrawerSummary) => void;
}) {
  const [kind, setKind] = useState<DrawerMovementKind>("DEPOSIT");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [toWalletId, setToWalletId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<{ drawer: DrawerSummary }>("/api/pos/drawer/movements", {
        method: "POST",
        body: JSON.stringify({ kind, amount: Number(amount), note: note.trim(), toWalletId: kind === "DEPOSIT" ? toWalletId || null : null, categoryId: kind === "EXPENSE" ? categoryId || null : null }),
      });
      onDone(res.drawer);
      onOpenChange(false);
      setAmount("");
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {kind === "CASH_IN" ? <ArrowDownToLine className="size-5" /> : <ArrowUpFromLine className="size-5" />}
            Cash in / out of the drawer
          </DialogTitle>
          <DialogDescription>The drawer should hold {formatBDT(expected)} right now.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {DRAWER_MOVEMENT_KINDS.map((k) => (
              <Button key={k} type="button" variant={kind === k ? "default" : "outline"} className="h-auto min-h-11 justify-start py-2 text-left whitespace-normal" onClick={() => setKind(k)}>
                {DRAWER_MOVEMENT_LABELS[k]}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mv-amount">Amount</Label>
            <Input id="mv-amount" className="h-11 text-base tabular-nums" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {kind === "DEPOSIT" ? (
            <div className="flex flex-col gap-1.5">
              <Label>Went to</Label>
              <WalletSelect wallets={wallets} value={toWalletId} onChange={setToWalletId} className="h-11 w-full" />
            </div>
          ) : null}
          {kind === "EXPENSE" ? (
            <div className="flex flex-col gap-1.5">
              <Label>What for</Label>
              <Select value={categoryId} onValueChange={(v) => setCategoryId((v as string) ?? "")}>
                <SelectTrigger className="h-11 w-full">
                  <SelectValue placeholder="Pick a category">{(v: string) => categories.find((c) => c.id === v)?.name ?? "Pick a category"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mv-note">Note</Label>
            <Input id="mv-note" className="h-11" value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === "DEPOSIT" ? "e.g. evening bank deposit" : kind === "EXPENSE" ? "e.g. tea for customers" : kind === "CASH_IN" ? "e.g. owner added change" : "e.g. owner took cash"} />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button className="h-11" disabled={busy || !amount || note.trim().length < 3} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
