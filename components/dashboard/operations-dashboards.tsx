import Link from "next/link";
import { AlertTriangle, Banknote, Boxes, PackageCheck, PackageOpen, Receipt, ShieldCheck, Truck, Wallet } from "lucide-react";

import { AlertRow, SectionTitle, StatTile, TileGrid } from "@/components/dashboard/parts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionUser } from "@/lib/auth/types";
import { codHref, collectionHref, expensesHref, ordersHref, packingHref } from "@/lib/dashboard/links";
import { COD_OVERDUE_DAYS, getAccountsNumbers, getLowStockSummary, getPackingNumbers } from "@/lib/dashboard/operations";
import type { DashboardPanels } from "@/lib/dashboard/panels";
import type { DashboardPeriod } from "@/lib/dashboard/ranges";
import { SALES_WHERE } from "@/lib/orders/list-where";
import { scopedWhere } from "@/lib/auth/scope";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { WALLET_TYPE_LABELS } from "@/lib/wallets/constants";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// PRD §4.16 Packing: queue count, packed today, ready to hand over, low
// stock. Accounts: unverified payments, today's collection, COD pending,
// wallet balances, today's expenses. Each number opens its list.

async function LowStockCard() {
  const low = await getLowStockSummary();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Low stock</CardTitle>
        <CardDescription>
          {low.variants === 0 ? "Every active size and colour is above its threshold." : `${low.variants} size/colour${low.variants === 1 ? "" : "s"} across ${low.products} product${low.products === 1 ? "" : "s"}.`}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" render={<Link href="/inventory/low-stock" />} nativeButton={false}>
            All alerts
          </Button>
        </CardAction>
      </CardHeader>
      {low.top.length > 0 ? (
        <CardContent>
          <ul className="flex flex-col">
            {low.top.map((p) => (
              <AlertRow key={p.productId} icon={p.out ? AlertTriangle : Boxes} label={p.name} count="" detail={p.message} href="/inventory/low-stock" active={p.out} />
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

export async function PackingDashboard({ panels }: { panels: DashboardPanels }) {
  const { counts, slaHours } = await getPackingNumbers(prisma);
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle title="Packing" description={`Orders turn overdue after ${slaHours} hours in the queue.`} />
      <TileGrid className="xl:grid-cols-4">
        <StatTile label="To pack" value={counts.queue} href={packingHref("queue")} icon={PackageOpen} sub="confirmed, oldest first" />
        <StatTile label="Overdue" value={counts.overdue} href={packingHref("overdue")} icon={AlertTriangle} sub={`waiting over ${slaHours}h`} tone={counts.overdue > 0 ? "danger" : undefined} />
        <StatTile label="Packed today" value={counts.packed_today} href={packingHref("packed_today")} icon={PackageCheck} />
        <StatTile label="Ready to hand over" value={counts.ready} href={packingHref("ready")} icon={Truck} sub="packed, waiting for the courier" />
      </TileGrid>
      {panels.can.inventory ? <LowStockCard /> : null}
    </section>
  );
}

export async function AccountsDashboard({ user, panels, period }: { user: SessionUser; panels: DashboardPanels; period: DashboardPeriod }) {
  const n = await getAccountsNumbers(prisma, user, { cod: panels.can.cod, wallets: panels.can.wallets, expenses: panels.can.expenses }, new Date(), period);
  const range = period.range;
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle title="Accounts" description={`Money waiting to be checked, and what came in and went out · ${period.label}.`} />
      <TileGrid className="xl:grid-cols-4">
        <StatTile label="Unverified payments" value={n.unverified.count} href="/payments" sub={formatBDT(n.unverified.amount)} icon={ShieldCheck} tone={n.unverified.count > 0 ? "warning" : undefined} />
        <StatTile label="Collection" value={formatBDT(n.collected.amount)} href={collectionHref(range)} sub={`${n.collected.count} payment${n.collected.count === 1 ? "" : "s"} · ${period.label}`} icon={Wallet} />
        {n.cod ? (
          <StatTile
            label="COD pending"
            value={formatBDT(n.cod.amount)}
            href={codHref()}
            sub={n.cod.overdueCount > 0 ? `${n.cod.count} parcels · ${n.cod.overdueCount} over ${COD_OVERDUE_DAYS} days` : `${n.cod.count} parcels delivered, not paid out`}
            icon={Truck}
            tone={n.cod.overdueCount > 0 ? "danger" : undefined}
          />
        ) : null}
        {panels.can.expenses ? (
          <StatTile label="Expenses" value={formatBDT(n.expenses.amount)} href={expensesHref(range)} sub={`${n.expenses.count} entr${n.expenses.count === 1 ? "y" : "ies"} · ${period.label}`} icon={Receipt} />
        ) : null}
      </TileGrid>
      {n.wallets ? (
        <Card>
          <CardHeader>
            <CardTitle>Wallet balances</CardTitle>
            <CardDescription>Verified money only — what&apos;s waiting for verification is shown beside it.</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" render={<Link href="/payments/wallets" />} nativeButton={false}>
                Wallets
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {n.wallets.map((w) => (
                <li key={w.id}>
                  <Link href={`/payments/wallets/${w.id}`} className="flex items-center justify-between gap-3 rounded-lg border p-3 hover:bg-muted/40">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{w.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {WALLET_TYPE_LABELS[w.type]}
                        {w.pendingVerificationCount > 0 ? ` · ${formatBDT(w.pendingVerification)} to verify` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{formatBDT(w.balance)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {n.pendingRefunds > 0 ? (
        <p className="text-sm text-muted-foreground">
          <Link href="/payments/refunds" className="underline-offset-4 hover:underline">
            {n.pendingRefunds} refund{n.pendingRefunds === 1 ? "" : "s"} awaiting approval
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/** The showroom till's own sales in the period — scoped to the operator (rule 6). */
export async function CounterDashboard({ user, period }: { user: SessionUser; period: DashboardPeriod }) {
  const { range } = period;
  const where = scopedWhere({ AND: [{ deletedAt: null }, SALES_WHERE, { createdAt: { gte: dhakaDayStartUtc(range.from), lt: dhakaDayStartUtc(range.to, 1) } }] }, user) as Prisma.OrderWhereInput;
  const sales = await prisma.order.aggregate({ where, _sum: { total: true }, _count: { _all: true } });
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle title="At the counter" />
      <TileGrid className="xl:grid-cols-4">
        <StatTile label="My sales" value={formatBDT(sales._sum.total ?? 0)} href={ordersHref({ preset: "sales", range })} sub={`${sales._count._all} sale${sales._count._all === 1 ? "" : "s"} · ${period.label}`} icon={Banknote} />
      </TileGrid>
    </section>
  );
}
