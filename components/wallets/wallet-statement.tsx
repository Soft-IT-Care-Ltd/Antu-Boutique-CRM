"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Ban, ChevronLeft, ScrollText } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { formatDhakaDate } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { WALLET_ENTRY_TYPE_LABELS, WALLET_FLOW_SOURCE_LABELS, WALLET_TYPE_LABELS, type WalletEntryTypeValue, type WalletFlowSource, type WalletTypeValue } from "@/lib/wallets/constants";

type Row = { at: string; source: WalletFlowSource; sourceId: string; reference: string | null; orderId: string | null; note: string | null; amount: string; balance: string };
type Statement = {
  wallet: { id: string; name: string; type: WalletTypeValue; accountNo: string | null; openingDate: string; balance: string };
  openingBalance: string;
  moneyIn: string;
  moneyOut: string;
  closingBalance: string;
  rows: Row[];
  truncated: boolean;
};

/** PRD §4.10 — a wallet statement for a date range, with the running balance after each line. */
export function WalletStatementView({ walletId, initialRange, canVoid }: { walletId: string; initialRange: DateRangeValue; canVoid: boolean }) {
  const [range, setRange] = useState(initialRange);
  const { from, to } = dateRangeQuery(range, { bounded: true });
  const [data, setData] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!from || !to) return;
    fetchJson<{ statement: Statement }>(`/api/wallets/${walletId}/statement?from=${from}&to=${to}`)
      .then((r) => {
        setData(r.statement);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the statement."));
  }, [walletId, from, to]);
  useEffect(load, [load]);

  async function voidEntry() {
    if (!voiding) return;
    setBusy(true);
    try {
      await fetchJson(`/api/wallets/entries/${voiding.sourceId}/void`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      setVoiding(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not void the entry.");
    } finally {
      setBusy(false);
    }
  }

  const label = (r: Row) => (r.source === "ENTRY" && r.reference ? WALLET_ENTRY_TYPE_LABELS[r.reference as WalletEntryTypeValue] : WALLET_FLOW_SOURCE_LABELS[r.source]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" render={<Link href="/payments/wallets" />} nativeButton={false}>
            <ChevronLeft />
            Wallets
          </Button>
          {data ? (
            <>
              <h2 className="text-xl font-semibold">{data.wallet.name}</h2>
              <p className="text-sm text-muted-foreground">
                {WALLET_TYPE_LABELS[data.wallet.type]}
                {data.wallet.accountNo ? ` · ${data.wallet.accountNo}` : ""} · balance today {formatBDT(data.wallet.balance)}
              </p>
            </>
          ) : (
            <Skeleton className="h-7 w-48" />
          )}
        </div>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ["Opening", data.openingBalance],
            ["Money in", data.moneyIn],
            ["Money out", data.moneyOut],
            ["Closing", data.closingBalance],
          ].map(([k, v]) => (
            <Card key={k}>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">{k}</p>
                <p className="text-lg font-semibold tabular-nums">{formatBDT(v)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {!data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
          <ScrollText className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No money moved in this range</p>
          <p className="text-sm text-muted-foreground">Unverified payments and pending refunds don&apos;t appear until they&apos;re verified / approved.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              {canVoid ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={`${r.source}-${r.sourceId}`}>
                <TableCell className="whitespace-nowrap text-sm">{formatDhakaDate(r.at)}</TableCell>
                <TableCell className="text-sm">
                  {label(r)}
                  {r.orderId ? (
                    <Link href={`/orders/${r.orderId}`} className="ml-1 font-mono text-xs hover:underline">
                      {r.reference}
                    </Link>
                  ) : r.source !== "ENTRY" && r.reference ? (
                    <span className="ml-1 text-xs text-muted-foreground">{r.reference}</span>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-72 truncate text-sm text-muted-foreground">{r.note ?? ""}</TableCell>
                <TableCell className={`text-right tabular-nums ${Number(r.amount) < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}>
                  {Number(r.amount) > 0 ? "+" : ""}
                  {formatBDT(r.amount)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatBDT(r.balance)}</TableCell>
                {canVoid ? (
                  <TableCell className="text-right">
                    {r.source === "ENTRY" ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Void entry"
                        onClick={() => {
                          setReason("");
                          setVoiding(r);
                        }}
                      >
                        <Ban />
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data?.truncated ? <p className="text-sm text-muted-foreground">Showing the first 2,000 lines — narrow the date range to see the rest. Totals above cover the whole range.</p> : null}

      <Dialog open={voiding !== null} onOpenChange={(o) => !o && setVoiding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void this entry?</DialogTitle>
            <DialogDescription>
              {voiding ? `${label(voiding)} · ${formatBDT(voiding.amount)}` : null}. A transfer voids both sides. The entry stays on record, marked void.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="void-reason">Reason (required)</Label>
            <Textarea id="void-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={voidEntry}>
              Void entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
