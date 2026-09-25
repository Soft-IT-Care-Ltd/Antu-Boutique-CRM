import "server-only";

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { toPaisa } from "@/lib/inventory/costing";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { NOT_A_SALE_STATUSES } from "@/lib/targets/constants";
import { monthRange } from "@/lib/targets/month";
import { EMPTY_STATS, statsFromBuckets, type StatusBucket, type Stats } from "@/lib/targets/stats";

// PRD §4.13 — a month's sales per person and per team, always recomputed
// from the orders themselves so progress is live and can't drift.
//
// A person's month is the orders they created; a team's is the orders
// carrying its teamId (copied from the creator when the order was placed,
// like every scoped list). Order totals only — never cost or profit, so
// nothing here needs stripping for a Sales Executive.

function monthOrderWhere(month: string): Prisma.OrderWhereInput {
  const { from, to } = monthRange(month);
  return {
    createdAt: { gte: from, lt: to },
    deletedAt: null,
    exchangedFromOrderId: null,
    status: { notIn: [...NOT_A_SALE_STATUSES] },
  };
}

function fold(rows: { key: string | null; status: OrderStatusValue; total: Prisma.Decimal | null; count: number }[]): Map<string, Stats> {
  const buckets = new Map<string, StatusBucket[]>();
  for (const r of rows) {
    if (!r.key) continue;
    const list = buckets.get(r.key) ?? [];
    list.push({ status: r.status, totalPaisa: r.total ? toPaisa(r.total) : 0, count: r.count });
    buckets.set(r.key, list);
  }
  return new Map([...buckets].map(([k, b]) => [k, statsFromBuckets(b)]));
}

/** Month stats per user id (the creator). Users with no orders are absent from the map. */
export async function statsByUser(db: Db, month: string, userIds?: string[]): Promise<Map<string, Stats>> {
  const rows = await db.order.groupBy({
    by: ["createdById", "status"],
    where: { ...monthOrderWhere(month), createdById: userIds ? { in: userIds } : { not: null } },
    _sum: { total: true },
    _count: { _all: true },
  });
  return fold(rows.map((r) => ({ key: r.createdById, status: r.status, total: r._sum.total, count: r._count._all })));
}

/** Month stats per team id. */
export async function statsByTeam(db: Db, month: string, teamIds?: string[]): Promise<Map<string, Stats>> {
  const rows = await db.order.groupBy({
    by: ["teamId", "status"],
    where: { ...monthOrderWhere(month), teamId: teamIds ? { in: teamIds } : { not: null } },
    _sum: { total: true },
    _count: { _all: true },
  });
  return fold(rows.map((r) => ({ key: r.teamId, status: r.status, total: r._sum.total, count: r._count._all })));
}

export const statsOrEmpty = (map: Map<string, Stats>, key: string): Stats => map.get(key) ?? EMPTY_STATS;
