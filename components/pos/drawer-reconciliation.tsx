import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDhakaDate, formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import type { DrawerSummary } from "@/lib/pos/types";

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-destructive" : tone === "good" ? "text-emerald-700 dark:text-emerald-400" : ""}`}>{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

const dayLabel = (ymd: string) => formatDhakaDate(`${ymd}T00:00:00+06:00`);

/**
 * PRD §4.7 end-of-day cash reconciliation: opening, cash sales, other cash
 * in, cash out, what the drawer should hold, what was counted, and every
 * movement behind those figures.
 */
export function DrawerReconciliation({ drawer }: { drawer: DrawerSummary }) {
  const closed = drawer.status === "CLOSED";
  const diff = drawer.difference ? Number(drawer.difference) : null;
  const lateRows = drawer.rows.filter((r) => r.afterClose);
  const bookGap = Number(drawer.walletBalanceNow) - Number(closed ? (drawer.closingCount ?? 0) : drawer.expectedClose);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={closed ? "secondary" : "default"}>{closed ? "Closed" : "Open"}</Badge>
        <span className="font-medium">{dayLabel(drawer.businessDay)}</span>
        <span className="text-muted-foreground">
          · {drawer.walletName} · opened {formatDhakaDateTime(drawer.openedAt)} by {drawer.openedByName ?? "—"}
          {closed && drawer.closedAt ? ` · closed ${formatDhakaDateTime(drawer.closedAt)} by ${drawer.closedByName ?? "—"}` : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Opening count" value={formatBDT(drawer.openingCount)} hint={drawer.openingNote ?? undefined} />
        <Stat label="Cash sales" value={formatBDT(drawer.totals.cashSales)} hint={`${drawer.totals.cashSalesCount} POS sale${drawer.totals.cashSalesCount === 1 ? "" : "s"}`} />
        <Stat label="Other cash in" value={formatBDT(drawer.totals.otherCashIn)} />
        <Stat label="Cash out" value={`− ${formatBDT(drawer.totals.cashOut)}`} />
        <Stat label={closed ? "Should have held" : "Should hold now"} value={formatBDT(drawer.expectedClose)} />
        {closed ? (
          <Stat
            label="Counted at close"
            value={formatBDT(drawer.closingCount ?? 0)}
            hint={diff === null || diff === 0 ? "Matched" : `${diff < 0 ? "Short" : "Over"} ${formatBDT(Math.abs(diff))}`}
            tone={diff === null || diff === 0 ? "good" : "bad"}
          />
        ) : (
          <Stat label="Cash waiting to be verified" value={formatBDT(drawer.totals.unverified)} hint={`${drawer.totals.unverifiedCount} payment${drawer.totals.unverifiedCount === 1 ? "" : "s"} — the count verifies them`} />
        )}
      </div>

      {closed && diff !== null && diff !== 0 ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          {diff < 0 ? "Short" : "Over"} by <b>{formatBDT(Math.abs(diff))}</b> — posted once to <b>Cash over/short</b> from {drawer.walletName}
          {drawer.closeNote ? <> · “{drawer.closeNote}”</> : null}
        </p>
      ) : null}

      {lateRows.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {lateRows.length} movement{lateRows.length === 1 ? " was" : "s were"} recorded for this day after the drawer was counted (marked below). They weren&apos;t in the count, so the wallet no longer matches it — Accounts should check them.
        </p>
      ) : null}

      {Math.abs(bookGap) >= 0.01 ? (
        <p className="text-xs text-muted-foreground">
          {drawer.walletName}&apos;s books show {formatBDT(drawer.walletBalanceNow)} right now — {formatBDT(Math.abs(bookGap))} {bookGap > 0 ? "more" : "less"} than {closed ? "this count" : "the drawer should hold"}
          {closed ? " (later days' cash, or money recorded after the count)" : " (verified money only; a difference at opening shows here until Accounts fixes the opening balance)"}.
        </p>
      ) : null}

      {drawer.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">No cash has moved through the drawer yet.</p>
      ) : (
        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Order</TableHead>
                <TableHead className="text-right">In / out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drawer.rows.map((r) => (
                <TableRow key={`${r.source}-${r.id}`} className={r.afterClose ? "bg-amber-50/60 dark:bg-amber-950/40" : undefined}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDhakaDateTime(r.at).split(", ").pop()}</TableCell>
                  <TableCell>
                    {r.label}
                    {r.verified === false ? <Badge variant="outline" className="ml-1.5">unverified</Badge> : null}
                    {r.afterClose ? <Badge variant="outline" className="ml-1.5">after close</Badge> : null}
                    {r.note ? <div className="text-xs text-muted-foreground">{r.note}</div> : null}
                  </TableCell>
                  <TableCell>
                    {r.orderId ? (
                      <Link href={`/orders/${r.orderId}`} className="font-mono text-xs hover:underline">
                        {r.orderNo}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${Number(r.amount) < 0 ? "text-destructive" : ""}`}>
                    {Number(r.amount) < 0 ? "− " : "+ "}
                    {formatBDT(Math.abs(Number(r.amount)))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
