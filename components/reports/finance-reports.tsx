"use client";

import { useEffect, useState, type ReactNode } from "react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ChannelSelect, type ChannelFilterValue } from "@/components/orders/channel-select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { EXPENSE_KIND_LABELS, EXPENSE_NATURE_LABELS, type ExpenseKindValue, type ExpenseNatureValue } from "@/lib/expenses/constants";
import { formatDhakaDate } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_CHANNEL_LABELS, PAYMENT_METHOD_LABELS, type OrderChannelValue, type PaymentMethodValue } from "@/lib/orders/constants";

// P2.3 collection report and expense report — a date range (Dhaka days,
// inclusive) and a few breakdowns. Same data as /api/reports/*.

function useReport<T>(endpoint: string, from: string, to: string, extra = "") {
  const [report, setReport] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!from || !to) return;
    fetchJson<{ report: T }>(`${endpoint}?from=${from}&to=${to}${extra}`)
      .then((r) => {
        setReport(r.report);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the report."));
  }, [endpoint, from, to, extra]);
  return { report, error };
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums">{formatBDT(value)}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

function Loading() {
  return (
    <div className="grid gap-3 md:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

const dayLabel = (ymd: string) => formatDhakaDate(`${ymd}T00:00:00+06:00`);

// ---------------------------------------------------------------------------

type CollectionReport = {
  totals: { collected: string; verified: string; unverified: string; refunds: string; net: string; paymentCount: number; refundCount: number };
  byMethod: { method: PaymentMethodValue; count: number; collected: string; refunds: string }[];
  byWallet: { walletId: string | null; label: string; collected: string; refunds: string; net: string }[];
  byDay: { day: string; collected: string; refunds: string; net: string }[];
  byStaff: { name: string; count: number; collected: string }[];
  byChannel: { channel: OrderChannelValue; count: number; collected: string; refunds: string; net: string }[];
  storeCredit: { outstanding: string; customersWithCredit: number; issued: string; used: string; restored: string; adjusted: string; expired: string; channel: OrderChannelValue | null };
};

/**
 * P3.2 — store credit is what the shop owes customers (a liability), not
 * money collected: it never enters the figures above. It becomes revenue
 * only when spent, inside the total of the order it pays for.
 */
function StoreCreditPanel({ credit, to }: { credit: CollectionReport["storeCredit"]; to: string }) {
  const moved = [
    { label: "Issued", value: credit.issued, hint: "exchanges and returns settled as credit" },
    { label: "Used", value: credit.used, hint: "spent on orders — revenue there" },
    { label: "Given back", value: credit.restored, hint: "spent on orders later cancelled" },
    { label: "Adjusted (Admin)", value: credit.adjusted, hint: "net, + added / − taken away" },
    { label: "Expired", value: credit.expired, hint: credit.channel ? "lapsed unspent — whole shop" : "lapsed unspent" },
  ].filter((m) => Number(m.value) !== 0);
  return (
    <Section title="Store credit (a liability, not income)">
      <div className="flex flex-col gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Outstanding store credit on {dayLabel(to)}</p>
          <p className="text-lg font-semibold tabular-nums">{formatBDT(credit.outstanding)}</p>
          <p className="text-xs text-muted-foreground">
            Owed to {credit.customersWithCredit} customer{credit.customersWithCredit === 1 ? "" : "s"}, whole shop. It moves no cash, so it isn&apos;t in the collection above.
          </p>
        </div>
        {credit.channel && moved.length > 0 ? (
          <p className="text-xs text-muted-foreground">Issued, used and given back: {ORDER_CHANNEL_LABELS[credit.channel]} orders only.</p>
        ) : null}
        {moved.length > 0 ? (
          <Table>
            <TableBody>
              {moved.map((m) => (
                <TableRow key={m.label}>
                  <TableCell>
                    {m.label}
                    <span className="block text-xs text-muted-foreground">{m.hint}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatBDT(m.value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-xs text-muted-foreground">No store credit moved in this range.</p>
        )}
      </div>
    </Section>
  );
}

export function CollectionReportView({ initialRange }: { initialRange: DateRangeValue }) {
  const [range, setRange] = useState(initialRange);
  const { from, to } = dateRangeQuery(range, { bounded: true });
  const [channel, setChannel] = useState<ChannelFilterValue>("all");
  const { report, error } = useReport<CollectionReport>("/api/reports/collection", from, to, channel === "all" ? "" : `&channel=${channel}`);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <DateRangeFilter value={range} onChange={setRange} />
        <ChannelSelect value={channel} onChange={setChannel} />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!report ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Collected" value={report.totals.collected} hint={`${report.totals.paymentCount} payments`} />
            <Stat label="Of which unverified" value={report.totals.unverified} />
            <Stat label="Refunds (approved)" value={report.totals.refunds} hint={`${report.totals.refundCount} refunds`} />
            <Stat label="Net collection" value={report.totals.net} />
          </div>
          <StoreCreditPanel credit={report.storeCredit} to={to} />
          {report.totals.paymentCount + report.totals.refundCount === 0 ? (
            <Empty text="No payments in this range." />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <Section title="By channel">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead className="text-right">Payments</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byChannel.map((c) => (
                      <TableRow key={c.channel}>
                        <TableCell>{ORDER_CHANNEL_LABELS[c.channel]}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBDT(c.collected)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBDT(c.net)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
              <Section title="By method">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Payments</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Refunds</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byMethod.map((m) => (
                      <TableRow key={m.method}>
                        <TableCell>{PAYMENT_METHOD_LABELS[m.method]}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBDT(m.collected)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatBDT(m.refunds)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
              <Section title="By wallet">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Wallet</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Refunds</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byWallet.map((w) => (
                      <TableRow key={w.walletId ?? w.label}>
                        <TableCell>{w.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBDT(w.collected)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatBDT(w.refunds)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatBDT(w.net)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
              <Section title="By day">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Day</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Refunds</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byDay.map((d) => (
                      <TableRow key={d.day}>
                        <TableCell className="whitespace-nowrap">{dayLabel(d.day)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBDT(d.collected)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatBDT(d.refunds)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatBDT(d.net)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
              <Section title="Recorded by">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff</TableHead>
                      <TableHead className="text-right">Payments</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byStaff.map((s) => (
                      <TableRow key={s.name}>
                        <TableCell>{s.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatBDT(s.collected)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type ExpenseReport = {
  total: string;
  count: number;
  byNature: { nature: ExpenseNatureValue; amount: string }[];
  byKind: { kind: ExpenseKindValue; amount: string; categories: { name: string; count: number; amount: string }[] }[];
  byWallet: { walletId: string | null; label: string; amount: string }[];
  byDay: { day: string; amount: string }[];
};

export function ExpenseReportView({ initialRange }: { initialRange: DateRangeValue }) {
  const [range, setRange] = useState(initialRange);
  const { from, to } = dateRangeQuery(range, { bounded: true });
  const { report, error } = useReport<ExpenseReport>("/api/reports/expenses", from, to);
  const nature = (n: ExpenseNatureValue) => report?.byNature.find((b) => b.nature === n)?.amount ?? "0";

  return (
    <div className="flex flex-col gap-4">
      <DateRangeFilter value={range} onChange={setRange} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!report ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat label="Total expenses" value={report.total} hint={`${report.count} entries`} />
            <Stat label={EXPENSE_NATURE_LABELS.FIXED} value={nature("FIXED")} />
            <Stat label={EXPENSE_NATURE_LABELS.VARIABLE} value={nature("VARIABLE")} />
          </div>
          {report.count === 0 ? (
            <Empty text="No expenses in this range." />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <Section title="By category">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Entries</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byKind.flatMap((k) => [
                      <TableRow key={k.kind} className="bg-muted/40">
                        <TableCell className="font-medium">{EXPENSE_KIND_LABELS[k.kind]}</TableCell>
                        <TableCell />
                        <TableCell className="text-right font-medium tabular-nums">{formatBDT(k.amount)}</TableCell>
                      </TableRow>,
                      ...k.categories.map((c) => (
                        <TableRow key={`${k.kind}-${c.name}`}>
                          <TableCell className="pl-6 text-sm text-muted-foreground">{c.name}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{c.count}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatBDT(c.amount)}</TableCell>
                        </TableRow>
                      )),
                    ])}
                  </TableBody>
                </Table>
              </Section>
              <div className="flex flex-col gap-3">
                <Section title="Paid from">
                  <Table>
                    <TableBody>
                      {report.byWallet.map((w) => (
                        <TableRow key={w.walletId ?? "none"}>
                          <TableCell className="text-sm">{w.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatBDT(w.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Section>
                <Section title="By day">
                  <Table>
                    <TableBody>
                      {report.byDay.map((d) => (
                        <TableRow key={d.day}>
                          <TableCell className="whitespace-nowrap text-sm">{dayLabel(d.day)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatBDT(d.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Section>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
