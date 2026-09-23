"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, FileUp, HandCoins, Loader2, RotateCw, Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  STATEMENT_LINE_STATUS_LABELS,
  STATEMENT_SOURCE_LABELS,
  type AwaitingPayoutRow,
  type CodSummary,
  type StatementDetailView,
  type StatementLineView,
  type StatementRow,
} from "@/lib/courier/cod-types";
import { WalletSelect } from "@/components/wallets/wallet-select";
import { formatDhakaDate, formatDhakaDateTime, todayInDhaka } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { WalletOption } from "@/lib/wallets/constants";

type View = "awaiting" | "statements" | "discrepancies";
const PAGE_SIZE = 20;
const VIEW_LABELS: Record<View, string> = { awaiting: "Awaiting payout", statements: "Statements", discrepancies: "Discrepancies" };

type ListResponse = { view: View; items: (AwaitingPayoutRow | StatementRow | StatementLineView)[]; total: number; summary: CodSummary };

const LINE_BADGE: Record<StatementLineView["status"], "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "outline",
  MATCHED: "secondary",
  ACCEPTED: "secondary",
  MISMATCH: "destructive",
  UNMATCHED: "destructive",
  DISPUTED: "outline",
};

// PRD §4.9 COD reconciliation + Gift Valy Round 2 §2.7 payouts, for ACCOUNTS:
// every taka the courier pays out is justified against our orders.
export function CodReconciliation({ canSyncPayouts, payoutWallets }: { canSyncPayouts: boolean; payoutWallets: WalletOption[] }) {
  const [view, setView] = useState<View>("awaiting");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [statementId, setStatementId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<StatementLineView | null>(null);

  useEffect(() => {
    fetchJson<ListResponse>(`/api/courier/cod?view=${view}&page=${page}&pageSize=${PAGE_SIZE}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load COD data."));
  }, [view, page, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const items = data?.view === view ? data.items : null;
  const summary = data?.summary;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  async function syncPayouts() {
    setSyncing(true);
    setNotice(null);
    try {
      const res = await fetchJson<{ payouts: number; settled: number; discrepancies: number; unmatched: number; note?: string; errors: { error: string }[] }>(
        "/api/courier/steadfast/payouts/sync",
        { method: "POST" },
      );
      setNotice({
        tone: res.errors.length ? "error" : "ok",
        text:
          res.note ??
          `Checked ${res.payouts} payout${res.payouts === 1 ? "" : "s"}: ${res.settled} settled, ${res.discrepancies} mismatched, ${res.unmatched} not matched${res.errors.length ? ` · ${res.errors[0].error}` : ""}`,
      });
      reload();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Payouts sync failed." });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Awaiting payout" value={summary ? formatBDT(summary.awaitingCod) : null} hint={summary ? `${summary.awaitingCount} delivered parcel${summary.awaitingCount === 1 ? "" : "s"}` : ""} />
        <SummaryCard label="COD collected this month" value={summary ? formatBDT(summary.collectedThisMonth) : null} hint="From reconciled statements" />
        <SummaryCard
          label="Open discrepancies"
          value={summary ? String(summary.openDiscrepancies) : null}
          hint="Mismatched or unknown parcels"
          warn={(summary?.openDiscrepancies ?? 0) > 0}
        />
        <SummaryCard label="Last payouts sync" value={summary ? (summary.lastPayoutsSyncAt ? formatDhakaDateTime(summary.lastPayoutsSyncAt) : "Never") : null} hint="Steadfast, hourly" small />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={v === view ? "default" : "outline"}
              onClick={() => {
                setView(v);
                setPage(1);
              }}
            >
              {VIEW_LABELS[v]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {canSyncPayouts ? (
            <Button variant="outline" size="sm" disabled={syncing || !summary?.steadfastEnabled} onClick={syncPayouts} title={summary?.steadfastEnabled ? "" : "Steadfast integration is off"}>
              {syncing ? <Loader2 className="animate-spin" /> : <RotateCw />}
              Sync Steadfast payouts
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <FileUp />
            Import statement
          </Button>
        </div>
      </div>

      {notice ? <p className={`text-sm ${notice.tone === "ok" ? "text-emerald-600" : "text-destructive"}`}>{notice.text}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-14 text-center">
          <HandCoins className="size-8 text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">
            {view === "awaiting"
              ? "No delivered parcels are waiting on a courier payout."
              : view === "statements"
                ? "No courier statements yet. Sync Steadfast payouts, or import a statement."
                : "No open discrepancies — every payout line is justified."}
          </p>
        </div>
      ) : view === "awaiting" ? (
        <AwaitingTable rows={items as AwaitingPayoutRow[]} />
      ) : view === "statements" ? (
        <StatementsTable rows={items as StatementRow[]} onOpen={setStatementId} />
      ) : (
        <LinesTable rows={items as StatementLineView[]} showStatement onResolve={setResolving} />
      )}

      {items && items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {data?.total ?? 0}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}

      {importOpen ? (
        <ImportStatementDialog
          wallets={payoutWallets}
          onClose={() => setImportOpen(false)}
          onDone={(text) => {
            setImportOpen(false);
            setNotice({ tone: "ok", text });
            reload();
          }}
        />
      ) : null}
      {statementId ? <StatementDialog key={statementId} statementId={statementId} onClose={() => setStatementId(null)} onResolve={setResolving} reloadKey={reloadKey} /> : null}
      {resolving ? (
        <ResolveDialog
          key={resolving.id}
          line={resolving}
          onClose={() => setResolving(null)}
          onDone={() => {
            setResolving(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value, hint, warn, small }: { label: string; value: string | null; hint: string; warn?: boolean; small?: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        {value === null ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <div className={`${small ? "text-sm" : "text-xl"} font-semibold ${warn ? "text-amber-600" : ""}`}>{value}</div>
        )}
        <div className="text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function AwaitingTable({ rows }: { rows: AwaitingPayoutRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Order</TableHead>
          <TableHead className="hidden sm:table-cell">Consignment</TableHead>
          <TableHead>COD collected</TableHead>
          <TableHead className="hidden md:table-cell">Courier deduction</TableHead>
          <TableHead>Net receivable</TableHead>
          <TableHead className="hidden sm:table-cell">Waiting</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.shipmentId}>
            <TableCell>
              <Link href={`/orders/${r.orderId}`} className="font-mono font-medium hover:underline">
                {r.orderNo}
              </Link>
              <div className="text-xs text-muted-foreground">{r.customerName}</div>
            </TableCell>
            <TableCell className="hidden font-mono text-xs sm:table-cell">{r.consignmentId ?? "—"}</TableCell>
            <TableCell>{formatBDT(r.codCollected)}</TableCell>
            <TableCell className="hidden text-xs md:table-cell">
              {formatBDT(r.deliveryCharge)} {r.chargeKnown ? "" : <span className="text-muted-foreground">(est.)</span>} + {formatBDT(r.codFee)} COD fee
            </TableCell>
            <TableCell className="font-medium">{formatBDT(r.expectedNet)}</TableCell>
            <TableCell className={`hidden text-xs sm:table-cell ${r.daysWaiting > 7 ? "text-amber-600" : "text-muted-foreground"}`}>
              {r.daysWaiting}d since {formatDhakaDate(r.deliveredAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatementsTable({ rows, onOpen }: { rows: StatementRow[]; onOpen: (id: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Statement</TableHead>
          <TableHead className="hidden sm:table-cell">Date</TableHead>
          <TableHead>Net paid</TableHead>
          <TableHead className="hidden md:table-cell">Gross − charges</TableHead>
          <TableHead>Lines</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => (
          <TableRow key={s.id} className="cursor-pointer" onClick={() => onOpen(s.id)}>
            <TableCell>
              <div className="font-mono font-medium">{s.reference}</div>
              <div className="text-xs text-muted-foreground">
                {s.courierName} · {STATEMENT_SOURCE_LABELS[s.source]}
              </div>
            </TableCell>
            <TableCell className="hidden text-xs sm:table-cell">{formatDhakaDate(s.statementDate)}</TableCell>
            <TableCell className="font-medium">{formatBDT(s.netAmount)}</TableCell>
            <TableCell className="hidden text-xs md:table-cell">
              {formatBDT(s.grossAmount)} − {formatBDT(s.deliveryCharge)} − {formatBDT(s.codCharge)}
              {!s.identityHolds ? <span className="ml-1 text-destructive">≠ net</span> : null}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {s.status === "PROCESSING" ? <Badge variant="outline">Processing</Badge> : null}
                {s.reconciledAt ? <Badge variant="secondary">Reconciled</Badge> : null}
                <Badge variant="outline">
                  {s.settledCount}/{s.lineCount} settled
                </Badge>
                {s.openCount > 0 ? <Badge variant="destructive">{s.openCount} open</Badge> : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LinesTable({ rows, showStatement, onResolve }: { rows: StatementLineView[]; showStatement?: boolean; onResolve: (line: StatementLineView) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showStatement ? <TableHead>Statement</TableHead> : <TableHead>#</TableHead>}
          <TableHead>Parcel</TableHead>
          <TableHead>Their COD</TableHead>
          <TableHead className="hidden md:table-cell">Ours</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((l) => (
          <TableRow key={l.id}>
            <TableCell className="font-mono text-xs">{showStatement ? l.statementReference : l.lineNo}</TableCell>
            <TableCell>
              {l.orderId ? (
                <Link href={`/orders/${l.orderId}`} className="font-mono font-medium hover:underline">
                  {l.orderNo}
                </Link>
              ) : (
                <span className="font-mono">{l.invoice ?? "—"}</span>
              )}
              <div className="font-mono text-xs text-muted-foreground">{l.consignmentId ?? ""}</div>
            </TableCell>
            <TableCell>
              {formatBDT(l.codAmount)}
              {l.paidNet ? <div className="text-xs text-muted-foreground">net {formatBDT(l.paidNet)}</div> : null}
            </TableCell>
            <TableCell className="hidden text-xs md:table-cell">
              {l.ourCod ? formatBDT(l.ourCod) : "—"}
              {l.expectedNet ? <div className="text-muted-foreground">net {formatBDT(l.expectedNet)}</div> : null}
            </TableCell>
            <TableCell>
              <Badge variant={LINE_BADGE[l.status]}>{STATEMENT_LINE_STATUS_LABELS[l.status]}</Badge>
              {l.mismatchReason && (l.status === "MISMATCH" || l.status === "UNMATCHED") ? (
                <p className="mt-1 flex max-w-64 items-start gap-1 text-xs text-amber-600">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {l.mismatchReason}
                </p>
              ) : null}
              {l.resolveNote ? (
                <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                  {l.resolvedBy}: {l.resolveNote}
                </p>
              ) : null}
            </TableCell>
            <TableCell>
              {["MISMATCH", "UNMATCHED", "DISPUTED"].includes(l.status) ? (
                <Button size="sm" variant="outline" onClick={() => onResolve(l)}>
                  Resolve
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatementDialog({ statementId, onClose, onResolve, reloadKey }: { statementId: string; onClose: () => void; onResolve: (l: StatementLineView) => void; reloadKey: number }) {
  const [statement, setStatement] = useState<StatementDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchJson<{ statement: StatementDetailView }>(`/api/courier/statements/${statementId}`)
      .then((d) => setStatement(d.statement))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the statement."));
  }, [statementId, reloadKey]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="size-4" /> {statement ? `${statement.reference} — payout report` : "Payout report"}
          </DialogTitle>
          {statement ? (
            <DialogDescription>
              {statement.courierName} · {STATEMENT_SOURCE_LABELS[statement.source]} · {formatDhakaDate(statement.statementDate)} · into {statement.walletName ?? "—"}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!statement ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-4">
              <Figure label="Gross COD" value={formatBDT(statement.grossAmount)} />
              <Figure label="Delivery charges" value={`− ${formatBDT(statement.deliveryCharge)}`} />
              <Figure label="COD charges" value={`− ${formatBDT(statement.codCharge)}`} />
              <Figure label="Net paid" value={formatBDT(statement.netAmount)} strong />
            </div>
            <div className="flex flex-wrap gap-2">
              {statement.identityHolds ? (
                <Badge variant="secondary">
                  <CheckCircle2 /> Gross − charges = net
                </Badge>
              ) : (
                <Badge variant="destructive">Gross − charges ≠ net — check the statement</Badge>
              )}
              {statement.expectedNetSum ? <Badge variant="outline">Our expected net Σ {formatBDT(statement.expectedNetSum)}</Badge> : null}
              {statement.paidVsExpectedDiff ? (
                <Badge variant={Math.abs(Number(statement.paidVsExpectedDiff)) > 2 ? "destructive" : "secondary"}>
                  Paid vs expected {Number(statement.paidVsExpectedDiff) >= 0 ? "+" : ""}
                  {formatBDT(statement.paidVsExpectedDiff)}
                </Badge>
              ) : null}
              {statement.reconciledAt ? <Badge>Reconciled {formatDhakaDateTime(statement.reconciledAt)}</Badge> : <Badge variant="outline">Not reconciled yet</Badge>}
            </div>
            {statement.note ? <p className="text-muted-foreground">{statement.note}</p> : null}
            <LinesTable rows={statement.lines} onResolve={onResolve} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={strong ? "font-semibold" : ""}>{value}</div>
    </div>
  );
}

function ResolveDialog({ line, onClose, onDone }: { line: StatementLineView; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"ACCEPT" | "DISPUTE" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canAccept = line.orderId !== null && line.status !== "UNMATCHED";

  async function submit(action: "ACCEPT" | "DISPUTE") {
    setBusy(action);
    setError(null);
    try {
      await fetchJson(`/api/courier/statements/lines/${line.id}/resolve`, { method: "POST", body: JSON.stringify({ action, note }) });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not resolve.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve discrepancy</DialogTitle>
          <DialogDescription>
            {line.statementReference} · {line.orderNo ?? line.invoice ?? line.consignmentId}. Courier says COD {formatBDT(line.codAmount)}
            {line.ourCod ? `, we expected ${formatBDT(line.ourCod)}` : ""}.
          </DialogDescription>
        </DialogHeader>
        {line.mismatchReason ? <p className="rounded-md bg-muted p-2 text-sm">{line.mismatchReason}</p> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="resolve-note">Reason (required)</Label>
          <Textarea id="resolve-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Customer paid 50 tk less at the door, confirmed by call" />
        </div>
        <p className="text-xs text-muted-foreground">
          {canAccept
            ? "Accept records the courier's COD against the order and may complete it. Dispute leaves the money untouched while you take it up with the courier."
            : "This parcel isn't one of ours, so it can only be disputed."}
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null || note.trim().length < 5 || line.status === "DISPUTED"} onClick={() => submit("DISPUTE")}>
            {busy === "DISPUTE" ? <Loader2 className="animate-spin" /> : null}
            Dispute
          </Button>
          {canAccept ? (
            <Button disabled={busy !== null || note.trim().length < 5} onClick={() => submit("ACCEPT")}>
              {busy === "ACCEPT" ? <Loader2 className="animate-spin" /> : null}
              Accept their figure
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CourierOption = { id: string; name: string };

function ImportStatementDialog({ wallets, onClose, onDone }: { wallets: WalletOption[]; onClose: () => void; onDone: (summary: string) => void }) {
  const [couriers, setCouriers] = useState<CourierOption[]>([]);
  const [courierId, setCourierId] = useState("");
  const [reference, setReference] = useState("");
  const [statementDate, setStatementDate] = useState(todayInDhaka());
  const [walletId, setWalletId] = useState(wallets.find((w) => w.type === "BANK")?.id ?? wallets[0]?.id ?? "");
  const [netAmount, setNetAmount] = useState("");
  const [csv, setCsv] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ couriers: CourierOption[] }>("/api/couriers")
      .then((d) => {
        setCouriers(d.couriers);
        setCourierId((current) => current || (d.couriers.find((c) => /steadfast/i.test(c.name)) ?? d.couriers[0])?.id || "");
      })
      .catch(() => setError("Could not load couriers."));
  }, []);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setCsv(await file.text());
    if (!reference) setReference(file.name.replace(/\.csv$/i, ""));
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetchJson<{ outcome: { settled: number; discrepancies: number; unmatched: number; completed: number; reconciledNow: boolean } }>("/api/courier/statements", {
        method: "POST",
        body: JSON.stringify({ courierId, reference, statementDate, walletId: walletId || undefined, csv, ...(netAmount ? { netAmount: Number(netAmount) } : {}) }),
      });
      const o = res.outcome;
      onDone(
        `Statement ${reference} imported: ${o.settled} settled, ${o.discrepancies} mismatched, ${o.unmatched} not matched${o.completed ? `, ${o.completed} order${o.completed === 1 ? "" : "s"} completed` : ""}${o.reconciledNow ? " — fully reconciled" : ""}.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import courier statement</DialogTitle>
          <DialogDescription>
            Upload or paste the courier&apos;s CSV. Columns: <code>consignment_id</code> or <code>invoice</code> (order no.), <code>cod_amount</code>, and optionally{" "}
            <code>delivery_charge</code>, <code>cod_charge</code>. Each line is matched to our orders; matches settle the order&apos;s COD.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Courier</Label>
            <Select value={courierId} onValueChange={(v) => setCourierId(v as string)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Courier">{(value: string) => couriers.find((c) => c.id === value)?.name ?? "Courier"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {couriers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stmt-ref">Statement / invoice no.</Label>
            <Input id="stmt-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. SFC-30820783" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stmt-date">Paid on</Label>
            <Input id="stmt-date" type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stmt-wallet">Paid into</Label>
            <WalletSelect id="stmt-wallet" wallets={wallets} value={walletId} onChange={setWalletId} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="stmt-net">Net amount received (optional — checks the statement adds up)</Label>
            <Input id="stmt-net" type="number" min={0} step="0.01" value={netAmount} onChange={(e) => setNetAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="stmt-file">CSV file</Label>
            <Input id="stmt-file" type="file" accept=".csv,text/csv" onChange={(e) => readFile(e.target.files?.[0])} />
            <Textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"consignment_id,invoice,cod_amount,delivery_charge\n1234567,AB-2609-0012,1510,60"} className="font-mono text-xs" />
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !courierId || reference.trim().length < 2 || !csv.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Import and reconcile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
