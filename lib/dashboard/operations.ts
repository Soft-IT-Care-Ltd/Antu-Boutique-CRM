import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { codOverdueSummary, codSummary } from "@/lib/courier/cod-queries";
import { dashboardRanges, type DashboardRanges } from "@/lib/dashboard/ranges";
import type { Db } from "@/lib/db/tx";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { getLowStockAlerts } from "@/lib/inventory/stock-report";
import { packingViewWhere } from "@/lib/packing/queue";
import { PACKING_VIEWS, type PackingView } from "@/lib/packing/types";
import { paymentQueueCounts } from "@/lib/payments/queries";
import { getPackingSlaHours } from "@/lib/settings/get";
import { getWalletBalances, type WalletBalance } from "@/lib/wallets/ledger";

// P4.3 (PRD §4.16) — the Packing and Accounts dashboards, and the alert
// counts the owner's dashboard shares with them. Each figure is computed
// with the same where as the screen it links to.

/** Owner alert: COD the courier has held longer than this (the COD tab ambers a parcel past it too). */
export const COD_OVERDUE_DAYS = 7;

export type LowStockSummary = { products: number; variants: number; out: number; top: { productId: string; name: string; message: string; out: boolean }[] };

/** Low-stock alerts in brief — names and counts only, never cost. */
export async function getLowStockSummary(): Promise<LowStockSummary> {
  const alerts = await getLowStockAlerts();
  return {
    products: alerts.length,
    variants: alerts.reduce((a, p) => a + p.lowVariants.length, 0),
    out: alerts.reduce((a, p) => a + p.outCount, 0),
    top: alerts.slice(0, 5).map((a) => ({ productId: a.productId, name: a.productName, message: a.message, out: a.outCount > 0 })),
  };
}

export type PackingNumbers = { counts: Record<PackingView, number>; slaHours: number };

export async function getPackingNumbers(db: Db, now = new Date()): Promise<PackingNumbers> {
  const slaHours = await getPackingSlaHours();
  const counts = await Promise.all(PACKING_VIEWS.map((v) => db.order.count({ where: packingViewWhere(v, slaHours, now) })));
  return { counts: Object.fromEntries(PACKING_VIEWS.map((v, i) => [v, counts[i]])) as Record<PackingView, number>, slaHours };
}

export type AccountsNumbers = {
  ranges: DashboardRanges;
  unverified: { count: number; amount: string };
  pendingRefunds: number;
  collectedToday: { count: number; amount: string };
  expensesToday: { count: number; amount: string };
  cod: { count: number; amount: string; overdueCount: number; overdueAmount: string } | null;
  wallets: WalletBalance[] | null;
};

export async function getAccountsNumbers(db: Db, user: SessionUser, opts: { cod: boolean; wallets: boolean; expenses: boolean }, now = new Date()): Promise<AccountsNumbers> {
  const ranges = dashboardRanges(now);
  const from = dhakaDayStartUtc(ranges.today);
  const to = dhakaDayStartUtc(ranges.today, 1);
  const [queue, collected, expenses, cod, codLate, wallets] = await Promise.all([
    paymentQueueCounts(user),
    // The collection report's "Collected" for today.
    db.payment.aggregate({ where: { kind: "PAYMENT", paidAt: { gte: from, lt: to }, order: scopedWhere({ deletedAt: null }, user) as Prisma.OrderWhereInput }, _sum: { amount: true }, _count: { _all: true } }),
    opts.expenses ? db.expense.aggregate({ where: { deletedAt: null, expenseDate: { gte: from, lt: to } }, _sum: { amount: true }, _count: { _all: true } }) : null,
    opts.cod ? codSummary(user) : null,
    opts.cod ? codOverdueSummary(user, COD_OVERDUE_DAYS, now) : null,
    opts.wallets ? getWalletBalances(db) : null,
  ]);
  return {
    ranges,
    unverified: { count: queue.unverified, amount: queue.unverifiedAmount },
    pendingRefunds: queue.pendingRefunds,
    collectedToday: { count: collected._count._all, amount: fromPaisa(toPaisa(collected._sum.amount ?? 0)) },
    expensesToday: expenses ? { count: expenses._count._all, amount: fromPaisa(toPaisa(expenses._sum.amount ?? 0)) } : { count: 0, amount: "0.00" },
    cod: cod && codLate ? { count: cod.awaitingCount, amount: cod.awaitingCod, overdueCount: codLate.count, overdueAmount: codLate.amount } : null,
    wallets: wallets ? wallets.filter((w) => w.isActive) : null,
  };
}
