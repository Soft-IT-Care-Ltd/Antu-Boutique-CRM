import "server-only";

import type { Prisma } from "@prisma/client";

import { DELIVERY_STATUSES, IN_TRANSIT_STATUSES, NOT_COUNTED_AS_SALE, STUCK_AFTER_HOURS, STUCK_STATUSES, type OrderDateBasis, type OrderListPreset } from "@/lib/orders/list-presets";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { ORDER_TAB_BY_KEY, type OrderSubTabKey, type OrderTabKey } from "@/lib/orders/tabs";

// The where clauses behind lib/orders/list-presets.ts. The order list API
// and every dashboard count build from these, then AND in the caller's
// scope (lib/auth/scope.ts) — nothing here widens what a user may see.

/** Orders that count as sales (PRD §4.13): the same set targets and the leaderboard add up. */
export const SALES_WHERE: Prisma.OrderWhereInput = { status: { notIn: NOT_COUNTED_AS_SALE }, exchangedFromOrderId: null };

const HOUR_MS = 60 * 60 * 1000;

/** Hours an order may sit in `status` before it counts as stuck; null when it never does. */
export function stuckAfterHours(status: OrderStatusValue, packingSlaHours: number): number | null {
  const rule = STUCK_AFTER_HOURS[status];
  if (rule === undefined) return null;
  return rule === "packing_sla" ? packingSlaHours : rule;
}

/**
 * Stuck in `status`: in it now, and no status change since the cutoff —
 * every move writes an order_status_history row, so "none since the
 * cutoff" means it has been in this status at least that long. The
 * createdAt check covers an order with no history row at all.
 */
export function stuckInStatusWhere(status: OrderStatusValue, hours: number, now: Date): Prisma.OrderWhereInput {
  const cutoff = new Date(now.getTime() - hours * HOUR_MS);
  return { status, createdAt: { lt: cutoff }, statusHistory: { none: { createdAt: { gte: cutoff } } } };
}

export function stuckWhere(packingSlaHours: number, now: Date, only?: OrderStatusValue): Prisma.OrderWhereInput {
  const statuses = only ? STUCK_STATUSES.filter((s) => s === only) : STUCK_STATUSES;
  if (statuses.length === 0) return { id: { in: [] } };
  return { OR: statuses.map((s) => stuckInStatusWhere(s, stuckAfterHours(s, packingSlaHours)!, now)) };
}

export function presetWhere(preset: OrderListPreset, ctx: { packingSlaHours: number; now: Date }): Prisma.OrderWhereInput {
  switch (preset) {
    case "sales":
      return SALES_WHERE;
    case "due":
      return { AND: [SALES_WHERE, { dueAmount: { gt: 0 } }] };
    case "in_transit":
      return { status: { in: IN_TRANSIT_STATUSES } };
    case "stuck":
      return stuckWhere(ctx.packingSlaHours, ctx.now);
  }
}

/** A [from, to) instant range against the chosen date basis. */
export function dateBasisWhere(basis: OrderDateBasis, range: { gte?: Date; lt?: Date }): Prisma.OrderWhereInput {
  switch (basis) {
    case "placed":
      return { createdAt: range };
    case "packed":
      // A walk-in sale never passes through PACKED: it leaves the shop when it's sold.
      return { OR: [{ statusHistory: { some: { toStatus: "PACKED", createdAt: range } } }, { channel: "WALK_IN", createdAt: range }] };
    case "delivered":
      return { statusHistory: { some: { toStatus: { in: DELIVERY_STATUSES }, createdAt: range } } };
  }
}

export { dhakaDaysRange } from "@/lib/date-range";

// CORRECTIONS.md item 14 — the where behind each Orders tab and sub-tab.

const APPROVAL_PENDING = ["DELIVERY_APPROVAL_PENDING", "PARTIAL_DELIVERY_APPROVAL_PENDING", "RETURN_APPROVAL_PENDING"] as const;
const NONE: Prisma.OrderWhereInput = { id: { in: [] } };

export function orderTabWhere(tab: OrderTabKey, sub?: OrderSubTabKey): Prisma.OrderWhereInput {
  const def = ORDER_TAB_BY_KEY[tab];
  // Fulfilment states arrive with per-location stock and backorders (C3/C5).
  if (tab === "waiting_for_stock" || tab === "needs_transfer") return NONE;
  if (tab === "with_courier" && sub) {
    if (sub === "handed_over") return { status: "HANDED_TO_COURIER" };
    if (sub === "in_transit") return { status: "IN_TRANSIT", NOT: { shipment: { is: { subStatus: { in: [...APPROVAL_PENDING] } } } } };
    if (sub === "approval_pending") return { status: "IN_TRANSIT", shipment: { is: { subStatus: { in: [...APPROVAL_PENDING] } } } };
  }
  if (tab === "returns" && sub) {
    if (sub === "returned") return { status: { in: ["RETURNED", "REFUNDED"] } };
    if (sub === "exchange") return { status: "EXCHANGE_REQUESTED" };
  }
  return def.statuses === "all" ? {} : { status: { in: def.statuses } };
}
