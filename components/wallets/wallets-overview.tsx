"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownUp, ArrowLeftRight, ChevronRight, Loader2, Pencil, Plus, WalletCards } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { WalletSelect } from "@/components/wallets/wallet-select";
import { formatDhakaDate, todayInDhaka } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { WALLET_TYPE_LABELS, WALLET_TYPE_VALUES, type WalletTypeValue } from "@/lib/wallets/constants";

type WalletBalance = {
  id: string;
  name: string;
  type: WalletTypeValue;
  accountNo: string | null;
  isActive: boolean;
  openingBalance: string;
  openingDate: string;
  balance: string;
  pendingVerification: string;
  pendingVerificationCount: number;
};

const dhakaYmd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date(iso));

/** PRD §4.10/§4.12 — every wallet's running balance, the cash position, and manual entries/transfers. */
export function WalletsOverview({ canEntry, canManage }: { canEntry: boolean; canManage: boolean }) {
  const [wallets, setWallets] = useState<WalletBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"entry" | "transfer" | "new" | WalletBalance | null>(null);

  const load = useCallback(() => {
    fetchJson<{ wallets: WalletBalance[] }>("/api/wallets")
      .then((r) => {
        setWallets(r.wallets);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load wallets."));
  }, []);
  useEffect(load, [load]);

  const active = wallets?.filter((w) => w.isActive) ?? [];
  const cashPosition = active.reduce((a, w) => a + Number(w.balance), 0);
  const pending = active.reduce((a, w) => a + Number(w.pendingVerification), 0);
  const options = active.map((w) => ({ id: w.id, name: w.name, type: w.type }));

  function done(text: string) {
    setDialog(null);
    setNotice(text);
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Cash position (all active wallets)</p>
          {wallets ? <p className="text-3xl font-semibold tabular-nums">{formatBDT(cashPosition)}</p> : <Skeleton className="h-9 w-48" />}
          {pending > 0 ? <p className="text-xs text-muted-foreground">+ {formatBDT(pending)} recorded but not yet verified</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {canEntry ? (
            <>
              <Button variant="outline" onClick={() => setDialog("entry")} disabled={options.length === 0}>
                <ArrowDownUp />
                Money in / out
              </Button>
              <Button variant="outline" onClick={() => setDialog("transfer")} disabled={options.length < 2}>
                <ArrowLeftRight />
                Transfer
              </Button>
            </>
          ) : null}
          {canManage ? (
            <Button onClick={() => setDialog("new")}>
              <Plus />
              Add wallet
            </Button>
          ) : null}
        </div>
      </div>

      {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!wallets ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : wallets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <WalletCards className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No wallets yet</p>
          <p className="text-sm text-muted-foreground">Add the bKash, Nagad, bank and cash wallets the business uses, with their opening balances.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {wallets.map((w) => (
            <Card key={w.id} className={w.isActive ? "" : "opacity-60"}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                <div className="min-w-0">
                  <CardTitle className="truncate text-base">{w.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {WALLET_TYPE_LABELS[w.type]}
                    {w.accountNo ? ` · ${w.accountNo}` : ""}
                    {!w.isActive ? " · inactive" : ""}
                  </p>
                </div>
                {canManage ? (
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${w.name}`} onClick={() => setDialog(w)}>
                    <Pencil />
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                <p className={`text-2xl font-semibold tabular-nums ${Number(w.balance) < 0 ? "text-destructive" : ""}`}>{formatBDT(w.balance)}</p>
                <p className="text-xs text-muted-foreground">
                  Opening {formatBDT(w.openingBalance)} on {formatDhakaDate(w.openingDate)}
                </p>
                {w.pendingVerificationCount > 0 ? (
                  <Badge variant="outline" className="w-fit border-amber-500/40 text-amber-700 dark:text-amber-400">
                    {w.pendingVerificationCount} unverified · {formatBDT(w.pendingVerification)}
                  </Badge>
                ) : null}
                <Link href={`/payments/wallets/${w.id}`} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  Statement <ChevronRight className="size-3.5" />
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialog === "entry" ? <EntryDialog wallets={options} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog === "transfer" ? <TransferDialog wallets={options} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog === "new" || (dialog && typeof dialog === "object") ? (
        <WalletDialog wallet={dialog === "new" ? null : (dialog as WalletBalance)} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
    </div>
  );
}

type Opt = { id: string; name: string; type: WalletTypeValue };

function useSubmit(onDone: (text: string) => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(url: string, method: string, body: unknown, text: string) {
    setSaving(true);
    setError(null);
    try {
      await fetchJson(url, { method, body: JSON.stringify(body) });
      onDone(text);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }
  return { saving, error, setError, submit };
}

function EntryDialog({ wallets, onClose, onDone }: { wallets: Opt[]; onClose: () => void; onDone: (t: string) => void }) {
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? "");
  const [direction, setDirection] = useState<"IN" | "OUT">("IN");
  const [amount, setAmount] = useState("");
  const [entryDate, setEntryDate] = useState(todayInDhaka());
  const [note, setNote] = useState("");
  const { saving, error, submit } = useSubmit(onDone);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Money in / out</DialogTitle>
          <DialogDescription>For money that isn&apos;t an order payment, a refund or an expense — an owner top-up, a bank charge.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-wallet">Wallet</Label>
            <WalletSelect id="entry-wallet" wallets={wallets} value={walletId} onChange={setWalletId} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Direction</Label>
            <Select value={direction} onValueChange={(v) => setDirection(v as "IN" | "OUT")}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => (v === "IN" ? "Money in" : "Money out")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="IN">Money in</SelectItem>
                <SelectItem value="OUT">Money out</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-amount">Amount (৳)</Label>
            <Input id="entry-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-date">Date</Label>
            <Input id="entry-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="entry-note">What was it? (required)</Label>
            <Textarea id="entry-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={saving || !walletId || !Number(amount) || note.trim().length < 3}
            onClick={() => submit("/api/wallets/entries", "POST", { walletId, direction, amount: Number(amount), entryDate, note: note.trim() }, "Entry recorded.")}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({ wallets, onClose, onDone }: { wallets: Opt[]; onClose: () => void; onDone: (t: string) => void }) {
  const [fromWalletId, setFrom] = useState(wallets[0]?.id ?? "");
  const [toWalletId, setTo] = useState(wallets[1]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [entryDate, setEntryDate] = useState(todayInDhaka());
  const [note, setNote] = useState("");
  const { saving, error, submit } = useSubmit(onDone);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer between wallets</DialogTitle>
          <DialogDescription>e.g. bKash cash-out to the bank, or the day&apos;s cash deposited.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tr-from">From</Label>
            <WalletSelect id="tr-from" wallets={wallets} value={fromWalletId} onChange={setFrom} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tr-to">To</Label>
            <WalletSelect id="tr-to" wallets={wallets.filter((w) => w.id !== fromWalletId)} value={toWalletId} onChange={setTo} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tr-amount">Amount (৳)</Label>
            <Input id="tr-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tr-date">Date</Label>
            <Input id="tr-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="tr-note">Note (required)</Label>
            <Textarea id="tr-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={saving || !fromWalletId || !toWalletId || fromWalletId === toWalletId || !Number(amount) || note.trim().length < 3}
            onClick={() => submit("/api/wallets/transfers", "POST", { fromWalletId, toWalletId, amount: Number(amount), entryDate, note: note.trim() }, "Transfer recorded.")}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WalletDialog({ wallet, onClose, onDone }: { wallet: WalletBalance | null; onClose: () => void; onDone: (t: string) => void }) {
  const [name, setName] = useState(wallet?.name ?? "");
  const [type, setType] = useState<WalletTypeValue>(wallet?.type ?? "BKASH");
  const [accountNo, setAccountNo] = useState(wallet?.accountNo ?? "");
  const [openingBalance, setOpeningBalance] = useState(wallet?.openingBalance ?? "0");
  const [openingDate, setOpeningDate] = useState(wallet ? dhakaYmd(wallet.openingDate) : todayInDhaka());
  const [isActive, setIsActive] = useState(wallet?.isActive ?? true);
  const { saving, error, submit } = useSubmit(onDone);
  const body = { name: name.trim(), type, accountNo: accountNo.trim() || null, openingBalance: Number(openingBalance) || 0, openingDate, ...(wallet ? { isActive } : {}) };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{wallet ? `Edit ${wallet.name}` : "Add wallet"}</DialogTitle>
          <DialogDescription>The opening balance is what the wallet held at the start of the opening date. Changing it moves every balance and statement — it&apos;s audit-logged.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="w-name">Name</Label>
            <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="bKash Merchant" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as WalletTypeValue)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: WalletTypeValue) => WALLET_TYPE_LABELS[v]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {WALLET_TYPE_VALUES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {WALLET_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="w-acc">Account / number (optional)</Label>
            <Input id="w-acc" value={accountNo} onChange={(e) => setAccountNo(e.target.value)} placeholder="01XXXXXXXXX or bank A/C" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="w-open">Opening balance (৳)</Label>
            <Input id="w-open" type="number" step="0.01" inputMode="decimal" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="w-date">Opening date</Label>
            <Input id="w-date" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
          </div>
          {wallet ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              Active (inactive wallets can&apos;t take new money)
            </label>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={saving || name.trim().length < 2}
            onClick={() => (wallet ? submit(`/api/wallets/${wallet.id}`, "PATCH", body, "Wallet updated.") : submit("/api/wallets", "POST", body, "Wallet added."))}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {wallet ? "Save" : "Add wallet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
