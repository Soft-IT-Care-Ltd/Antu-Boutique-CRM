import "server-only";

import type { Prisma } from "@prisma/client";

import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { listLeaveRequests } from "@/lib/attendance/sheet";
import { attendanceViewLevel } from "@/lib/attendance/http";
import { dashboardRanges, type DashboardRanges } from "@/lib/dashboard/ranges";
import type { Db } from "@/lib/db/tx";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { LEAD_STATUS_VALUES, OPEN_LEAD_STATUSES, type LeadStatusValue } from "@/lib/leads/constants";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { SALES_WHERE } from "@/lib/orders/list-where";

// P4.3 (PRD §4.16) — the Sales Executive's dashboard, and the Team
// Leader's team version of it. Everything is scoped by the shared helper
// (CLAUDE.md rule 6): an executive's own leads and orders, a team leader's
// team's. Order totals and counts only — no cost, no profit, nothing about
// another executive.

/** Still being worked — counted whenever they were placed. */
export const OPEN_ORDER_STATUSES: OrderStatusValue[] = ["LEAD", "CONFIRMED", "PACKED", "HANDED_TO_COURIER", "IN_TRANSIT", "ON_HOLD", "PARTIAL_DELIVERED", "EXCHANGE_REQUESTED"];
/** Finished — counted for orders placed this month. */
export const CLOSED_ORDER_STATUSES: OrderStatusValue[] = ["DELIVERED", "COMPLETED", "CANCELLED", "RETURNED", "REFUNDED"];

export type SalesNumbers = {
  ranges: DashboardRanges;
  leads: { status: LeadStatusValue; count: number }[];
  leadsOpen: number;
  openOrders: { status: OrderStatusValue; count: number }[];
  closedThisMonth: { status: OrderStatusValue; count: number }[];
  month: { value: string; orders: number };
  today: { value: string; orders: number };
};

export async function getSalesNumbers(db: Db, user: SessionUser, now = new Date()): Promise<SalesNumbers> {
  const ranges = dashboardRanges(now);
  const monthFrom = dhakaDayStartUtc(ranges.monthStart);
  const todayFrom = dhakaDayStartUtc(ranges.today);
  const to = dhakaDayStartUtc(ranges.today, 1);
  const orderWhere = (where: Prisma.OrderWhereInput) => scopedWhere({ AND: [{ deletedAt: null }, where] }, user) as Prisma.OrderWhereInput;
  const leadWhere = (where: Prisma.LeadWhereInput) => scopedWhere({ AND: [{ deletedAt: null }, where] }, user) as Prisma.LeadWhereInput;

  const [leadRows, openRows, closedRows, month, today] = await Promise.all([
    db.lead.groupBy({ by: ["status"], where: leadWhere({ status: { in: [...OPEN_LEAD_STATUSES] } }), _count: { _all: true } }),
    db.order.groupBy({ by: ["status"], where: orderWhere({ status: { in: OPEN_ORDER_STATUSES } }), _count: { _all: true } }),
    db.order.groupBy({ by: ["status"], where: orderWhere({ status: { in: CLOSED_ORDER_STATUSES }, createdAt: { gte: monthFrom, lt: to } }), _count: { _all: true } }),
    db.order.aggregate({ where: orderWhere({ AND: [SALES_WHERE, { createdAt: { gte: monthFrom, lt: to } }] }), _sum: { total: true }, _count: { _all: true } }),
    db.order.aggregate({ where: orderWhere({ AND: [SALES_WHERE, { createdAt: { gte: todayFrom, lt: to } }] }), _sum: { total: true }, _count: { _all: true } }),
  ]);

  const countOf = <S extends string>(rows: { status: S; _count: { _all: number } }[], s: S) => rows.find((r) => r.status === s)?._count._all ?? 0;
  const leads = LEAD_STATUS_VALUES.filter((s) => (OPEN_LEAD_STATUSES as readonly string[]).includes(s)).map((status) => ({ status, count: countOf(leadRows, status) }));
  return {
    ranges,
    leads,
    leadsOpen: leads.reduce((a, l) => a + l.count, 0),
    openOrders: OPEN_ORDER_STATUSES.map((status) => ({ status, count: countOf(openRows, status) })),
    closedThisMonth: CLOSED_ORDER_STATUSES.map((status) => ({ status, count: countOf(closedRows, status) })),
    month: { value: fromPaisa(toPaisa(month._sum.total ?? 0)), orders: month._count._all },
    today: { value: fromPaisa(toPaisa(today._sum.total ?? 0)), orders: today._count._all },
  };
}

export type PendingApprovals = {
  editRequests: number | null;
  returns: number | null;
  exchanges: number | null;
  leave: number | null;
};

/**
 * PRD §4.16 TL: "pending approval requests (order edits, returns,
 * exchanges)" — plus leave, which a TL decides too (P4.2). Each is null
 * when the user can't approve that kind; counts match the list each links
 * to (same scope, same status).
 */
export async function getPendingApprovals(db: Db, user: SessionUser): Promise<PendingApprovals | null> {
  const [edits, returns, exchanges, leave] = await Promise.all([can(user, "order.edit_after_window"), can(user, "return.approve"), can(user, "exchange.approve"), can(user, "leave.approve")]);
  if (!edits && !returns && !exchanges && !leave) return null;
  const order = scopedWhere({ deletedAt: null }, user) as Prisma.OrderWhereInput;
  const level = leave ? await attendanceViewLevel(user) : null;
  const seesOthersLeave = level === "team" || level === "all";
  const [e, r, x, l] = await Promise.all([
    edits ? db.orderEditRequest.count({ where: { status: "PENDING", order } }) : null,
    returns ? db.returnCase.count({ where: { status: "REQUESTED", type: "RETURN", order } }) : null,
    exchanges ? db.returnCase.count({ where: { status: "REQUESTED", type: "EXCHANGE", order } }) : null,
    // The leave screen lists the scope's pending requests minus one's own.
    leave && seesOthersLeave ? listLeaveRequests(db, user, level!, { status: "PENDING" }).then((rows) => rows.filter((row) => row.userId !== user.id).length) : null,
  ]);
  return { editRequests: e, returns: r, exchanges: x, leave: l };
}
