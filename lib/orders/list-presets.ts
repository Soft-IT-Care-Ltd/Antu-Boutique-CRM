import type { OrderStatusValue } from "@/lib/orders/constants";
import { NOT_A_SALE_STATUSES, RETURNED_STATUSES } from "@/lib/targets/constants";

// P4.3 (PRD §4.16) — named slices of the order list that the dashboards
// link to, so "every number is clickable through to the list it
// summarises". Client- and server-safe: the list shows the labels, and the
// server builds the where from the same definitions
// (lib/orders/list-where.ts), so a dashboard number and the list it links
// to can't drift apart.

export const ORDER_LIST_PRESETS = ["sales", "due", "in_transit", "stuck"] as const;
export type OrderListPreset = (typeof ORDER_LIST_PRESETS)[number];

export const ORDER_LIST_PRESET_LABELS: Record<OrderListPreset, string> = {
  sales: "Counted as sales",
  due: "Money still due",
  in_transit: "With the courier",
  stuck: "Stuck in one status",
};

export const ORDER_LIST_PRESET_HINTS: Record<OrderListPreset, string> = {
  sales: "Not cancelled, not returned, and not an exchange's replacement — the same orders targets count.",
  due: "Sales with part of the total still unpaid.",
  in_transit: "Handed to the courier or on the way.",
  stuck: "Sitting in the same status longer than it should.",
};

/**
 * Not a sale: never confirmed, called off, or came back (PRD §4.13 —
 * the same rule targets and the leaderboard use).
 */
export const NOT_COUNTED_AS_SALE: OrderStatusValue[] = [...NOT_A_SALE_STATUSES, ...RETURNED_STATUSES];

export const IN_TRANSIT_STATUSES: OrderStatusValue[] = ["HANDED_TO_COURIER", "IN_TRANSIT"];

/** A courier delivery (full or partial) — the "delivered" end of the operations funnel. */
export const DELIVERY_STATUSES: OrderStatusValue[] = ["DELIVERED", "PARTIAL_DELIVERED"];

/**
 * How long an order may sit in one status before the owner's alert calls
 * it stuck. CONFIRMED uses the packing SLA setting (the queue's red line).
 * Statuses left out are either final or handled by their own alert
 * (DELIVERED waits on courier COD — "COD not received").
 */
export const STUCK_AFTER_HOURS: Partial<Record<OrderStatusValue, number | "packing_sla">> = {
  LEAD: 72,
  CONFIRMED: "packing_sla",
  PACKED: 24,
  HANDED_TO_COURIER: 72,
  IN_TRANSIT: 7 * 24,
  ON_HOLD: 72,
  PARTIAL_DELIVERED: 7 * 24,
  EXCHANGE_REQUESTED: 7 * 24,
};

export const STUCK_STATUSES = Object.keys(STUCK_AFTER_HOURS) as OrderStatusValue[];

/** "3 days", "24 hours". */
export function formatHours(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Which date the list's from/to range is read against: when the order was
 * placed (default), when it was packed (a walk-in sale: when it was sold),
 * or when the courier delivered it.
 */
export const ORDER_DATE_BASES = ["placed", "packed", "delivered"] as const;
export type OrderDateBasis = (typeof ORDER_DATE_BASES)[number];

export const ORDER_DATE_BASIS_LABELS: Record<OrderDateBasis, string> = {
  placed: "Placed",
  packed: "Packed / sold",
  delivered: "Delivered",
};
