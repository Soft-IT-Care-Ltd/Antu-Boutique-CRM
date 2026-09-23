import "server-only";

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { allocatePaisa } from "@/lib/expenses/allocate";
import { AD_ALLOCATION_SETTING_KEY, AD_ALLOCATION_VALUES, DEFAULT_AD_ALLOCATION, type AdAllocationMethod } from "@/lib/expenses/constants";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";

// PRD §4.12: "Ad-cost allocation: daily ad spend spread across that day's
// confirmed orders (setting: per-order equal split or by order value)."
//
// "That day's confirmed orders" = orders whose FIRST move into CONFIRMED
// (order_status_history) falls on that Dhaka calendar day, not deleted and
// not since CANCELLED. POS sales never pass through CONFIRMED, so showroom
// sales carry no ad cost. Nothing is stored per order: the split is derived
// from daily_ad_spend each time, so editing a day's spend or the setting
// re-spreads it consistently. Profit-related — callers gate on expense.view.

export async function getAdAllocationMethod(db: Db): Promise<AdAllocationMethod> {
  const row = await db.setting.findUnique({ where: { key: AD_ALLOCATION_SETTING_KEY } });
  return (AD_ALLOCATION_VALUES as readonly string[]).includes(row?.value ?? "") ? (row!.value as AdAllocationMethod) : DEFAULT_AD_ALLOCATION;
}

type ConfirmedOrderRow = { id: string; orderNo: string; total: Prisma.Decimal; confirmedAt: Date };

async function ordersConfirmedBetween(db: Db, start: Date, end: Date): Promise<ConfirmedOrderRow[]> {
  return db.$queryRaw<ConfirmedOrderRow[]>`
    SELECT o."id", o."orderNo", o."total", c."confirmedAt"
      FROM "orders" o
      JOIN (SELECT h."orderId", MIN(h."createdAt") AS "confirmedAt"
              FROM "order_status_history" h
             WHERE h."toStatus" = 'CONFIRMED'
             GROUP BY h."orderId") c ON c."orderId" = o."id"
     WHERE o."deletedAt" IS NULL AND o."status" <> 'CANCELLED'
       AND c."confirmedAt" >= ${start} AND c."confirmedAt" < ${end}
     ORDER BY c."confirmedAt", o."id"`;
}

export type DayAllocation = {
  day: string;
  method: AdAllocationMethod;
  spend: string;
  /** Spend on a day with no confirmed orders stays unallocated (it still counts in P&L). */
  unallocated: string;
  orders: { id: string; orderNo: string; total: string; allocated: string }[];
};

/** How one Dhaka day's (YYYY-MM-DD) ad spend splits over that day's confirmed orders. */
export async function getDayAllocation(db: Db, day: string, method?: AdAllocationMethod): Promise<DayAllocation> {
  const start = dhakaDayStartUtc(day);
  const end = dhakaDayStartUtc(day, 1);
  const resolvedMethod = method ?? (await getAdAllocationMethod(db));
  const [spend, orders] = await Promise.all([
    db.dailyAdSpend.aggregate({ where: { deletedAt: null, spendDate: { gte: start, lt: end } }, _sum: { amount: true } }),
    ordersConfirmedBetween(db, start, end),
  ]);
  const spendPaisa = toPaisa(spend._sum.amount ?? 0);
  const split = allocatePaisa(spendPaisa, orders.map((o) => ({ id: o.id, valuePaisa: toPaisa(o.total) })), resolvedMethod);
  return {
    day,
    method: resolvedMethod,
    spend: fromPaisa(spendPaisa),
    unallocated: fromPaisa(orders.length === 0 ? spendPaisa : 0),
    orders: orders.map((o) => ({ id: o.id, orderNo: o.orderNo, total: fromPaisa(toPaisa(o.total)), allocated: fromPaisa(split.get(o.id) ?? 0) })),
  };
}

const DHAKA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" });

/**
 * Allocated ad cost per order (in taka, as a string), for per-order profit
 * (PRD §4.12). Orders never confirmed, or confirmed on a day without ad
 * spend, get "0.00".
 */
export async function getAllocatedAdCostForOrders(db: Db, orderIds: string[]): Promise<Map<string, string>> {
  const result = new Map(orderIds.map((id) => [id, "0.00"]));
  if (orderIds.length === 0) return result;
  const confirmations = await db.orderStatusHistory.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orderIds }, toStatus: "CONFIRMED" },
    _min: { createdAt: true },
  });
  const days = new Set(confirmations.map((c) => DHAKA_DAY.format(c._min.createdAt!)));
  const method = await getAdAllocationMethod(db);
  for (const day of days) {
    const allocation = await getDayAllocation(db, day, method);
    for (const o of allocation.orders) if (result.has(o.id)) result.set(o.id, o.allocated);
  }
  return result;
}
