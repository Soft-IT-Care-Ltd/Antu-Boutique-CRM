import "server-only";

import { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { NON_OPERATING_EXPENSE_KINDS, type ExpenseKindValue } from "@/lib/expenses/constants";
import { toPaisa } from "@/lib/inventory/costing";
import type { OrderChannelValue } from "@/lib/orders/constants";
import { NOT_COUNTED_AS_SALE } from "@/lib/orders/list-presets";

// P4.3 (PRD §4.16) — the owner dashboard's profit, following the PRD §4.12
// P&L rule: profit = revenue − COGS − operating expenses.
//
// • Revenue and COGS are taken when the goods leave: the day an online
//   order is packed (the moment its unit_cost_snapshot freezes — CLAUDE.md
//   rule 3), or the moment a walk-in sale is rung up. An order that's only
//   confirmed has no frozen cost yet, so it has no profit yet either.
// • Revenue is the order total, which already drops by anything returned;
//   COGS is the frozen snapshot of the units the customer kept
//   (qty − returned_qty). An order that came back whole (RETURNED /
//   REFUNDED), or was cancelled, carries neither.
// • Operating expenses are the expenses table dated in the period, minus
//   supplier payments (stock cost reaches profit as COGS, never twice).
//
// Store-credit adjustments and expiries (P&L items in the §4.12 rule) are
// left to the full P&L in P4.4 — they're rare, and working out expiries
// means walking every customer's ledger.
//
// Cost and profit: callers gate on report.pl.view AND product.cost.view
// (Admin, Manager). Never call this for anyone else.

const DHAKA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" });
export const dhakaDayKey = (d: Date) => DHAKA_DAY.format(d);

export type ProfitTotals = {
  revenuePaisa: number;
  cogsPaisa: number;
  expensesPaisa: number;
  ordersOut: number;
};

export const EMPTY_PROFIT: ProfitTotals = { revenuePaisa: 0, cogsPaisa: 0, expensesPaisa: 0, ordersOut: 0 };

export const grossPaisa = (t: ProfitTotals) => t.revenuePaisa - t.cogsPaisa;
export const netPaisa = (t: ProfitTotals) => t.revenuePaisa - t.cogsPaisa - t.expensesPaisa;

export type OrderOut = {
  id: string;
  orderNo: string;
  channel: OrderChannelValue;
  outAt: Date;
  revenuePaisa: number;
  cogsPaisa: number;
};

export type ProfitReport = {
  totals: ProfitTotals;
  /** Per Dhaka day (YYYY-MM-DD); days with nothing are absent. */
  byDay: Map<string, ProfitTotals>;
  orders: OrderOut[];
  expensesByKind: { kind: ExpenseKindValue; paisa: number }[];
};

type OutRow = { id: string; orderNo: string; channel: OrderChannelValue; total: Prisma.Decimal; cogs: Prisma.Decimal | null; outAt: Date };

/** Orders whose goods left in [from, to): the first PACKED move, or a walk-in sale's own time. */
async function ordersOut(db: Db, from: Date, to: Date): Promise<OrderOut[]> {
  const rows = await db.$queryRaw<OutRow[]>`
    SELECT o."id", o."orderNo", o."channel"::text AS "channel", o."total", t."outAt",
           (SELECT SUM((i."qty" - i."returnedQty") * COALESCE(i."unitCostSnapshot", 0))
              FROM "order_items" i WHERE i."orderId" = o."id") AS "cogs"
      FROM "orders" o
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          (SELECT MIN(h."createdAt") FROM "order_status_history" h WHERE h."orderId" = o."id" AND h."toStatus" = 'PACKED'),
          CASE WHEN o."channel" = 'WALK_IN' THEN o."createdAt" END
        ) AS "outAt"
      ) t
     WHERE o."deletedAt" IS NULL
       AND o."status"::text NOT IN (${Prisma.join(NOT_COUNTED_AS_SALE)})
       AND o."createdAt" < ${to}
       AND t."outAt" >= ${from} AND t."outAt" < ${to}
     ORDER BY t."outAt" ASC`;
  return rows.map((r) => ({ id: r.id, orderNo: r.orderNo, channel: r.channel, outAt: r.outAt, revenuePaisa: toPaisa(r.total), cogsPaisa: toPaisa(r.cogs ?? 0) }));
}

function bucket(map: Map<string, ProfitTotals>, day: string): ProfitTotals {
  let t = map.get(day);
  if (!t) {
    t = { ...EMPTY_PROFIT };
    map.set(day, t);
  }
  return t;
}

export async function getProfitReport(db: Db, from: Date, to: Date): Promise<ProfitReport> {
  const [orders, expenses] = await Promise.all([
    ordersOut(db, from, to),
    db.expense.findMany({
      where: { deletedAt: null, expenseDate: { gte: from, lt: to }, category: { kind: { notIn: NON_OPERATING_EXPENSE_KINDS } } },
      select: { amount: true, expenseDate: true, category: { select: { kind: true } } },
    }),
  ]);

  const totals = { ...EMPTY_PROFIT };
  const byDay = new Map<string, ProfitTotals>();
  const byKind = new Map<ExpenseKindValue, number>();

  for (const o of orders) {
    const d = bucket(byDay, dhakaDayKey(o.outAt));
    for (const t of [totals, d]) {
      t.revenuePaisa += o.revenuePaisa;
      t.cogsPaisa += o.cogsPaisa;
      t.ordersOut += 1;
    }
  }
  for (const e of expenses) {
    const paisa = toPaisa(e.amount);
    totals.expensesPaisa += paisa;
    bucket(byDay, dhakaDayKey(e.expenseDate)).expensesPaisa += paisa;
    byKind.set(e.category.kind, (byKind.get(e.category.kind) ?? 0) + paisa);
  }

  return {
    totals,
    byDay,
    orders,
    expensesByKind: [...byKind].map(([kind, paisa]) => ({ kind, paisa })).sort((a, b) => b.paisa - a.paisa),
  };
}

/** Adds up the days of a report that fall in [fromDay, toDay] (inclusive YYYY-MM-DD). */
export function sumDays(byDay: Map<string, ProfitTotals>, fromDay: string, toDay: string): ProfitTotals {
  const out = { ...EMPTY_PROFIT };
  for (const [day, t] of byDay) {
    if (day < fromDay || day > toDay) continue;
    out.revenuePaisa += t.revenuePaisa;
    out.cogsPaisa += t.cogsPaisa;
    out.expensesPaisa += t.expensesPaisa;
    out.ordersOut += t.ordersOut;
  }
  return out;
}
