"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone, Pencil, Plus, Trash2 } from "lucide-react";

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
import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WalletSelect } from "@/components/wallets/wallet-select";
import {
  AD_ALLOCATION_LABELS,
  AD_ALLOCATION_VALUES,
  AD_PLATFORM_LABELS,
  AD_PLATFORM_VALUES,
  type AdAllocationMethod,
  type AdPlatformValue,
} from "@/lib/expenses/constants";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { formatDhakaDate, todayInDhaka } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { WalletOption } from "@/lib/wallets/constants";

type AdSpendItem = { id: string; spendDate: string; platform: AdPlatformValue; amount: string; walletId: string; walletName: string; note: string | null; createdByName: string | null };
type Allocation = { day: string; method: AdAllocationMethod; spend: string; unallocated: string; orders: { id: string; orderNo: string; total: string; allocated: string }[] };

const dhakaYmd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date(iso));

/**
 * PRD §4.12 — daily ad spend, and how each day's spend is spread over that
 * day's confirmed orders (equal split or by order value — an Admin setting).
 */
export function AdSpendView({
  wallets,
  canCreate,
  canEdit,
  canDelete,
  canSetAllocation,
}: {
  wallets: WalletOption[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canSetAllocation: boolean;
}) {
  const [data, setData] = useState<{ items: AdSpendItem[]; total: number; totalAmount: string } | null>(null);
  const pager = usePager("ad_spend");
  const { page, pageSize, setPage } = pager;
  const [range, setRange] = useState<DateRangeValue>({ preset: "all" });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdSpendItem | "new" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [day, setDay] = useState(todayInDhaka());
  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [savingMethod, setSavingMethod] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...dateRangeQuery(range) });
    fetchJson<{ items: AdSpendItem[]; total: number; totalAmount: string }>(`/api/expenses/ad-spend?${params.toString()}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load ad spend."));
  }, [page, pageSize, range]);
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (!day) return;
    fetchJson<{ allocation: Allocation }>(`/api/expenses/ad-spend/allocation?day=${day}`)
      .then((r) => setAllocation(r.allocation))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the allocation."));
  }, [day, reloadKey]);

  async function setMethod(method: AdAllocationMethod) {
    setSavingMethod(true);
    try {
      await fetchJson("/api/expenses/ad-spend/allocation", { method: "PUT", body: JSON.stringify({ method }) });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the setting.");
    } finally {
      setSavingMethod(false);
    }
  }

  async function remove(id: string) {
    try {
      await fetchJson(`/api/expenses/ad-spend/${id}`, { method: "DELETE" });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete.");
    }
  }

  const items = data?.items ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DateRangeFilter
            value={range}
            onChange={(v) => {
              setRange(v);
              pager.reset();
            }}
          />
          <p className="text-sm text-muted-foreground">Each row is also posted as an &ldquo;Ad cost&rdquo; expense from its wallet.</p>
          {canCreate ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add ad spend
            </Button>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!items ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
            <Megaphone className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No ad spend recorded</p>
            <p className="text-sm text-muted-foreground">Enter each day&apos;s Facebook / Instagram boost spend so it lands in per-order profit.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Paid from</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    <button type="button" className="hover:underline" onClick={() => setDay(dhakaYmd(a.spendDate))}>
                      {formatDhakaDate(a.spendDate)}
                    </button>
                  </TableCell>
                  <TableCell className="text-sm">
                    {AD_PLATFORM_LABELS[a.platform]}
                    {a.note ? <div className="text-xs text-muted-foreground">{a.note}</div> : null}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.walletName}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatBDT(a.amount)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {canEdit ? (
                      <Button variant="ghost" size="icon-sm" aria-label="Edit ad spend" onClick={() => setEditing(a)}>
                        <Pencil />
                      </Button>
                    ) : null}
                    {canDelete ? (
                      <AlertDialog>
                        <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Delete ad spend" />}>
                          <Trash2 />
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this ad spend?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {formatBDT(a.amount)} on {formatDhakaDate(a.spendDate)} — its Ad cost expense goes too, and that day&apos;s orders lose the allocation.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => remove(a.id)}>Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {items && items.length > 0 ? (
          <ListPagination page={page} pageSize={pageSize} total={data!.total} noun="entries" onPageChange={setPage} onPageSizeChange={pager.setPageSize}>
            {" "}
            · {formatBDT(data!.totalAmount)} in total
          </ListPagination>
        ) : null}
      </div>

      <Card className="h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Allocation to orders</CardTitle>
          <p className="text-xs text-muted-foreground">A day&apos;s spend is spread over the orders first confirmed that day (not cancelled). POS sales carry none.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="alloc-day" className="text-xs">
                Day
              </Label>
              <Input id="alloc-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Split</Label>
              {canSetAllocation ? (
                <Select value={allocation?.method ?? ""} onValueChange={(v) => setMethod(v as AdAllocationMethod)} disabled={savingMethod || !allocation}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="…">{(v: AdAllocationMethod) => AD_ALLOCATION_LABELS[v]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {AD_ALLOCATION_VALUES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {AD_ALLOCATION_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="py-1.5 text-sm">{allocation ? AD_ALLOCATION_LABELS[allocation.method] : "…"}</p>
              )}
            </div>
          </div>
          {!allocation ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <p className="text-sm">
                <span className="font-medium">{formatBDT(allocation.spend)}</span> spent · {allocation.orders.length} confirmed order{allocation.orders.length === 1 ? "" : "s"}
              </p>
              {Number(allocation.unallocated) > 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">No confirmed orders that day — {formatBDT(allocation.unallocated)} stays unallocated (it still counts as an expense).</p>
              ) : null}
              {allocation.orders.length > 0 ? (
                <div className="max-h-80 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Ad cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allocation.orders.map((o) => (
                        <TableRow key={o.id}>
                          <TableCell>
                            <Link href={`/orders/${o.id}`} className="font-mono text-xs hover:underline">
                              {o.orderNo}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">{formatBDT(o.total)}</TableCell>
                          <TableCell className="text-right text-sm font-medium tabular-nums">{formatBDT(o.allocated)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <AdSpendDialog
          item={editing === "new" ? null : editing}
          wallets={wallets}
          onClose={() => setEditing(null)}
          onSaved={(savedDay) => {
            setEditing(null);
            setDay(savedDay);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function AdSpendDialog({ item, wallets, onClose, onSaved }: { item: AdSpendItem | null; wallets: WalletOption[]; onClose: () => void; onSaved: (day: string) => void }) {
  const [spendDate, setSpendDate] = useState(item ? dhakaYmd(item.spendDate) : todayInDhaka());
  const [platform, setPlatform] = useState<AdPlatformValue>(item?.platform ?? "FACEBOOK");
  const [amount, setAmount] = useState(item?.amount ?? "");
  const [walletId, setWalletId] = useState(item?.walletId ?? wallets.find((w) => w.type === "BKASH")?.id ?? wallets[0]?.id ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = { spendDate, platform, amount: Number(amount), walletId, note: note.trim() || null };
      await fetchJson(item ? `/api/expenses/ad-spend/${item.id}` : "/api/expenses/ad-spend", { method: item ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved(spendDate);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? "Edit ad spend" : "Add ad spend"}</DialogTitle>
          <DialogDescription>The day the boost ran — it&apos;s spread over that day&apos;s confirmed orders.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ad-date">Day</Label>
            <Input id="ad-date" type="date" value={spendDate} onChange={(e) => setSpendDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Platform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as AdPlatformValue)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: AdPlatformValue) => AD_PLATFORM_LABELS[v]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AD_PLATFORM_VALUES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {AD_PLATFORM_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ad-amount">Amount (৳)</Label>
            <Input id="ad-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ad-wallet">Paid from</Label>
            <WalletSelect id="ad-wallet" wallets={wallets} value={walletId} onChange={setWalletId} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="ad-note">Note (campaign, page...)</Label>
            <Input id="ad-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={saving || !walletId || !Number(amount)} onClick={save}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {item ? "Save" : "Add ad spend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
