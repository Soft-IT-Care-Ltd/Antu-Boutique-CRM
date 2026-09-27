import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { expensesHref } from "@/lib/dashboard/links";
import { dashboardRanges } from "@/lib/dashboard/ranges";
import { EXPENSE_KIND_LABELS, OPERATING_EXPENSE_FILTER } from "@/lib/expenses/constants";
import { getProfitReport, grossPaisa, netPaisa } from "@/lib/finance/profit";
import { dhakaDayStartUtc, formatDhakaDateTime } from "@/lib/inventory/constants";
import { fromPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { ORDER_CHANNEL_LABELS } from "@/lib/orders/constants";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 500;

const money = (paisa: number) => formatBDT(fromPaisa(paisa));

// P4.3 — what the dashboard's Profit figure is made of, for a Dhaka date
// range: the orders that went out (revenue and frozen cost) and the
// operating expenses (PRD §4.12 P&L rule, lib/finance/profit.ts). Cost and
// profit: Admin/Manager only (report.pl.view + product.cost.view). The
// full P&L with month-on-month comparison is P4.4.
export default async function ProfitBreakdownPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/reports");
  if (!(await can(user, ["report.pl.view", "product.cost.view"], "all"))) redirect("/dashboard");

  const ranges = dashboardRanges();
  const params = await searchParams;
  const day = z.string().regex(DAY);
  let from = day.catch(ranges.monthStart).parse(params.from);
  let to = day.catch(ranges.today).parse(params.to);
  if (to < from) [from, to] = [to, from];

  const report = await getProfitReport(prisma, dhakaDayStartUtc(from), dhakaDayStartUtc(to, 1));
  const t = report.totals;
  const net = netPaisa(t);
  const gross = grossPaisa(t);
  const margin = t.revenuePaisa > 0 ? `${((gross / t.revenuePaisa) * 100).toFixed(1)}%` : "—";

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Profit breakdown</h1>
          <p className="text-sm text-muted-foreground">Orders that went out in the period, what they cost, and the period&apos;s operating expenses.</p>
        </div>
        <form className="flex flex-wrap items-center gap-2" method="get">
          <Input type="date" name="from" defaultValue={from} className="w-36" aria-label="From" />
          <Input type="date" name="to" defaultValue={to} className="w-36" aria-label="To" />
          <Button type="submit" variant="outline">
            Show
          </Button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-5">
        <Figure label="Revenue" value={money(t.revenuePaisa)} sub={`${t.ordersOut} orders out`} />
        <Figure label="Cost of goods" value={money(t.cogsPaisa)} sub="frozen at packing" />
        <Figure label="Gross profit" value={money(gross)} sub={`${margin} margin`} />
        <Link href={expensesHref({ from, to }, OPERATING_EXPENSE_FILTER)} className="rounded-xl border bg-card p-3 hover:bg-muted/40 sm:p-4">
          <FigureBody label="Operating expenses" value={money(t.expensesPaisa)} sub="not counting stock bought" />
        </Link>
        <Figure label="Profit" value={money(net)} sub={t.revenuePaisa > 0 ? `${((net / t.revenuePaisa) * 100).toFixed(1)}% of revenue` : undefined} danger={net < 0} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Orders out</CardTitle>
            <CardDescription>Packed (or sold at the counter) in the period. Returned and cancelled orders carry no revenue or cost.</CardDescription>
          </CardHeader>
          <CardContent>
            {report.orders.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Nothing went out in this period.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead className="hidden sm:table-cell">Out</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...report.orders]
                      .reverse()
                      .slice(0, MAX_ROWS)
                      .map((o) => (
                        <TableRow key={o.id}>
                          <TableCell>
                            <Link href={`/orders/${o.id}`} className="font-mono font-medium hover:underline">
                              {o.orderNo}
                            </Link>
                            {o.channel === "WALK_IN" ? (
                              <Badge variant="outline" className="ml-1.5">
                                {ORDER_CHANNEL_LABELS[o.channel]}
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground sm:table-cell">{formatDhakaDateTime(o.outAt)}</TableCell>
                          <TableCell className="text-right tabular-nums">{money(o.revenuePaisa)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{money(o.cogsPaisa)}</TableCell>
                          <TableCell className={cn("text-right font-medium tabular-nums", o.revenuePaisa - o.cogsPaisa < 0 && "text-destructive")}>{money(o.revenuePaisa - o.cogsPaisa)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {report.orders.length > MAX_ROWS ? <p className="pt-2 text-sm text-muted-foreground">Showing the latest {MAX_ROWS} of {report.orders.length} — the totals above include them all.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Operating expenses</CardTitle>
            <CardDescription>By heading. Supplier payments are left out — stock reaches profit as cost of goods.</CardDescription>
          </CardHeader>
          <CardContent>
            {report.expensesByKind.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses in this period.</p>
            ) : (
              <ul className="flex flex-col">
                {report.expensesByKind.map((e) => (
                  <li key={e.kind}>
                    <Link href={expensesHref({ from, to }, e.kind)} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                      <span>{EXPENSE_KIND_LABELS[e.kind]}</span>
                      <span className="font-medium tabular-nums">{money(e.paisa)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Profit = revenue − cost of goods − operating expenses (PRD §4.12). Store-credit adjustments and expiries join in the{" "}
        <Link href={`/reports/pl?from=${from}&to=${to}`} className="underline hover:text-foreground">
          full P&amp;L report
        </Link>
        .
      </p>
    </div>
  );
}

function FigureBody({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <>
      <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
      <p className={cn("truncate text-xl font-semibold tabular-nums sm:text-2xl", danger && "text-destructive")}>{value}</p>
      {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
    </>
  );
}

function Figure(props: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-3 sm:p-4">
      <FigureBody {...props} />
    </div>
  );
}
