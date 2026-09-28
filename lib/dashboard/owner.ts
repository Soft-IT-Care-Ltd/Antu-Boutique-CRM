import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { dashboardPeriod, dashboardRanges, type DashboardPeriod, type DashboardRanges } from "@/lib/dashboard/ranges";
import type { ChannelSplit, OwnerDayPoint } from "@/lib/dashboard/types";
import type { Db } from "@/lib/db/tx";
import { dhakaDayKey, getProfitReport, netPaisa, sumDays, type ProfitTotals } from "@/lib/finance/profit";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { OPEN_LEAD_STATUSES } from "@/lib/leads/constants";
import { DELIVERY_STATUSES, IN_TRANSIT_STATUSES, STUCK_STATUSES } from "@/lib/orders/list-presets";
import { SALES_WHERE, stuckAfterHours, stuckWhere } from "@/lib/orders/list-where";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { getPackingSlaHours } from "@/lib/settings/get";
import { shortDay, shiftDay } from "@/lib/dashboard/links";

// P4.3 (PRD §4.16) — the owner's 10-second view: today, the chosen period
// (the dashboard's date filter, CORRECTIONS.md item 16 — This Month by
// default), the live operations funnel, the daily charts and the
// stuck-order alert.
// Whole-shop numbers, still run through the shared scope helper (it adds
// nothing for Admin/Manager — a per-user grant can never widen it).
// Profit and cost live here: the page renders this only for
// report.pl.view + product.cost.view.

export type PeriodRow = {
  orders: number;
  value: string;
  due: string;
  collected: string;
  expenses: string;
  /** Revenue − COGS − operating expenses (lib/finance/profit.ts). */
  profit: string;
  /** What left the shop in the period — the revenue the profit is on. */
  revenueOut: string;
  ordersOut: number;
};

export type OwnerNumbers = {
  ranges: DashboardRanges;
  period: DashboardPeriod;
  today: PeriodRow;
  /** The period the dashboard's date filter picked. */
  inPeriod: PeriodRow;
  funnel: { leadsOpen: number; confirmed: number; packed: number; inTransit: number; deliveredToday: number };
  days: OwnerDayPoint[];
  channel: ChannelSplit;
  returnRate: { comeBack: number; reached: number; rate: number | null };
  stuck: { status: OrderStatusValue; count: number; hours: number }[];
};

type Bucket = { orders: number; value: number; due: number; collected: number; online: number; walkIn: number; onlineOrders: number; walkInOrders: number };
const emptyBucket = (): Bucket => ({ orders: 0, value: 0, due: 0, collected: 0, online: 0, walkIn: 0, onlineOrders: 0, walkInOrders: 0 });

function sumBuckets(map: Map<string, Bucket>, fromDay: string, toDay: string): Bucket {
  const out = emptyBucket();
  for (const [day, b] of map) {
    if (day < fromDay || day > toDay) continue;
    for (const k of Object.keys(out) as (keyof Bucket)[]) out[k] += b[k];
  }
  return out;
}

function periodRow(b: Bucket, p: ProfitTotals): PeriodRow {
  return {
    orders: b.orders,
    value: fromPaisa(b.value),
    due: fromPaisa(b.due),
    collected: fromPaisa(b.collected),
    expenses: fromPaisa(p.expensesPaisa),
    profit: fromPaisa(netPaisa(p)),
    revenueOut: fromPaisa(p.revenuePaisa),
    ordersOut: p.ordersOut,
  };
}

const count = (map: Map<string, number>, day: string) => map.set(day, (map.get(day) ?? 0) + 1);

export async function getOwnerNumbers(db: Db, user: SessionUser, now = new Date(), period = dashboardPeriod({ preset: "this_month" }, undefined, now)): Promise<OwnerNumbers> {
  const ranges = dashboardRanges(now);
  const { today } = ranges;
  const { from: chartFrom, to: chartTo } = period.chartRange;
  // One fetch covers today, the period and the charts.
  const windowFrom = [today, period.range.from, chartFrom].sort()[0];
  const from = dhakaDayStartUtc(windowFrom);
  const to = dhakaDayStartUtc(today, 1);
  const chartStart = dhakaDayStartUtc(chartFrom);
  const chartEnd = dhakaDayStartUtc(chartTo, 1);
  const orderScope = (where: Prisma.OrderWhereInput) => scopedWhere({ AND: [{ deletedAt: null }, where] }, user) as Prisma.OrderWhereInput;
  const slaHours = await getPackingSlaHours();

  const [sales, payments, profit, leadsOpen, funnelCounts, deliveredToday, reachedRows, walkInRows, courierReturns, cases, stuckRows] = await Promise.all([
    db.order.findMany({ where: orderScope({ AND: [SALES_WHERE, { createdAt: { gte: from, lt: to } }] }), select: { createdAt: true, total: true, dueAmount: true, channel: true } }),
    // The collection report's "Collected": money received (refunds and credits are other kinds).
    db.payment.findMany({ where: { kind: "PAYMENT", paidAt: { gte: from, lt: to }, order: orderScope({}) }, select: { paidAt: true, amount: true } }),
    getProfitReport(db, from, to),
    db.lead.count({ where: scopedWhere({ deletedAt: null, status: { in: [...OPEN_LEAD_STATUSES] } }, user) as Prisma.LeadWhereInput }),
    db.order.groupBy({ by: ["status"], where: orderScope({ status: { in: ["CONFIRMED", "PACKED", ...IN_TRANSIT_STATUSES] } }), _count: { _all: true } }),
    db.order.count({ where: orderScope({ statusHistory: { some: { toStatus: { in: DELIVERY_STATUSES }, createdAt: { gte: dhakaDayStartUtc(today), lt: to } } } }) }),
    // Return / exchange rate: of what reached a customer, how much came back.
    db.orderStatusHistory.findMany({ where: { toStatus: { in: DELIVERY_STATUSES }, createdAt: { gte: chartStart, lt: chartEnd }, order: orderScope({}) }, select: { orderId: true, createdAt: true } }),
    db.order.findMany({ where: orderScope({ channel: "WALK_IN", status: { not: "CANCELLED" }, createdAt: { gte: chartStart, lt: chartEnd } }), select: { createdAt: true } }),
    db.orderStatusHistory.findMany({
      where: { toStatus: "RETURNED", fromStatus: { in: IN_TRANSIT_STATUSES }, createdAt: { gte: chartStart, lt: chartEnd }, order: orderScope({}) },
      select: { createdAt: true },
    }),
    db.returnCase.findMany({ where: { status: { notIn: ["REJECTED", "CANCELLED"] }, createdAt: { gte: chartStart, lt: chartEnd }, order: orderScope({}) }, select: { type: true, createdAt: true } }),
    db.order.groupBy({ by: ["status"], where: orderScope(stuckWhere(slaHours, now)), _count: { _all: true } }),
  ]);

  const byDay = new Map<string, Bucket>();
  const bucket = (day: string) => {
    let b = byDay.get(day);
    if (!b) byDay.set(day, (b = emptyBucket()));
    return b;
  };
  for (const o of sales) {
    const b = bucket(dhakaDayKey(o.createdAt));
    const paisa = toPaisa(o.total);
    b.orders += 1;
    b.value += paisa;
    b.due += toPaisa(o.dueAmount);
    if (o.channel === "WALK_IN") {
      b.walkIn += paisa;
      b.walkInOrders += 1;
    } else {
      b.online += paisa;
      b.onlineOrders += 1;
    }
  }
  for (const p of payments) bucket(dhakaDayKey(p.paidAt)).collected += toPaisa(p.amount);

  const reachedByDay = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of reachedRows) {
    const day = dhakaDayKey(r.createdAt);
    if (seen.has(`${r.orderId}:${day}`)) continue;
    seen.add(`${r.orderId}:${day}`);
    count(reachedByDay, day);
  }
  for (const w of walkInRows) count(reachedByDay, dhakaDayKey(w.createdAt));
  const returnsByDay = new Map<string, number>();
  const exchangesByDay = new Map<string, number>();
  for (const r of courierReturns) count(returnsByDay, dhakaDayKey(r.createdAt));
  for (const c of cases) count(c.type === "EXCHANGE" ? exchangesByDay : returnsByDay, dhakaDayKey(c.createdAt));

  const days: OwnerDayPoint[] = [];
  for (let day = chartFrom; day <= chartTo; day = shiftDay(day, 1)) {
    const b = byDay.get(day) ?? emptyBucket();
    const p = profit.byDay.get(day);
    days.push({
      day,
      label: shortDay(day),
      online: b.online / 100,
      walkIn: b.walkIn / 100,
      orders: b.orders,
      profit: p ? netPaisa(p) / 100 : 0,
      returns: returnsByDay.get(day) ?? 0,
      exchanges: exchangesByDay.get(day) ?? 0,
    });
  }

  const inPeriod = sumBuckets(byDay, period.range.from, period.range.to);
  const comeBack = courierReturns.length + cases.length;
  const reached = [...reachedByDay.values()].reduce((a, n) => a + n, 0) + courierReturns.length;
  const funnel = new Map(funnelCounts.map((r) => [r.status, r._count._all]));

  return {
    ranges,
    period,
    today: periodRow(sumBuckets(byDay, today, today), sumDays(profit.byDay, today, today)),
    inPeriod: periodRow(inPeriod, sumDays(profit.byDay, period.range.from, period.range.to)),
    funnel: {
      leadsOpen,
      confirmed: funnel.get("CONFIRMED") ?? 0,
      packed: funnel.get("PACKED") ?? 0,
      inTransit: IN_TRANSIT_STATUSES.reduce((a, s) => a + (funnel.get(s) ?? 0), 0),
      deliveredToday,
    },
    days,
    channel: { online: inPeriod.online / 100, walkIn: inPeriod.walkIn / 100, onlineOrders: inPeriod.onlineOrders, walkInOrders: inPeriod.walkInOrders },
    returnRate: { comeBack, reached, rate: reached > 0 ? comeBack / reached : null },
    stuck: STUCK_STATUSES.map((status) => ({ status, count: stuckRows.find((r) => r.status === status)?._count._all ?? 0, hours: stuckAfterHours(status, slaHours)! })).filter((s) => s.count > 0),
  };
}
