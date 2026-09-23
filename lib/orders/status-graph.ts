import type { OrderStatusValue } from "@/lib/orders/constants";

// Pure transition data — deliberately NOT "server-only" so both the API
// route/service (lib/orders/lifecycle.ts) and the client-side status
// control (components/orders/order-status-control.tsx) can share the exact
// same rules. The status control needs this because after a client-side
// status change, the order's current status lives in React state, not in
// the page's server-computed initial props — recomputing "what's legal
// next" from that live state (via this module) is what keeps the option
// list correct across multiple changes without a full page reload.
//
// See lib/orders/lifecycle.ts for the full rationale (PRD §4.6 lifecycle,
// why PACKED is excluded from the generic route, ON_HOLD resume semantics).
export const ORDER_TRANSITIONS: Record<OrderStatusValue, OrderStatusValue[]> = {
  LEAD: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "ON_HOLD", "CANCELLED"],
  PACKED: ["HANDED_TO_COURIER", "ON_HOLD", "CANCELLED"],
  HANDED_TO_COURIER: ["IN_TRANSIT", "ON_HOLD", "RETURNED"],
  IN_TRANSIT: ["DELIVERED", "PARTIAL_DELIVERED", "RETURNED"],
  DELIVERED: ["COMPLETED", "RETURNED", "EXCHANGE_REQUESTED"],
  COMPLETED: ["RETURNED", "EXCHANGE_REQUESTED"],
  ON_HOLD: ["CONFIRMED", "PACKED", "HANDED_TO_COURIER", "IN_TRANSIT", "CANCELLED"],
  CANCELLED: [],
  RETURNED: ["REFUNDED"],
  REFUNDED: [],
  EXCHANGE_REQUESTED: ["COMPLETED", "CANCELLED"],
  // P2.2 — the customer kept part of the parcel. Once kept items are marked
  // and Accounts has reviewed the money, the order completes (or, Phase 3,
  // turns into an exchange).
  PARTIAL_DELIVERED: ["COMPLETED", "EXCHANGE_REQUESTED"],
};

// PACKED is reserved for P1.6's packing checklist (stock deduction + cost
// snapshot in the same transaction as the status move) — never a plain
// status change.
// PARTIAL_DELIVERED only ever comes from the courier (lib/courier/sync.ts),
// which also opens the kept-items / condition-check task for it.
export const STATUSES_REQUIRING_DEDICATED_FLOW: OrderStatusValue[] = ["PACKED", "PARTIAL_DELIVERED"];

// Statuses a booked courier shipment owns: once a consignment exists, only
// the courier sync may move the order into these, so the order can't drift
// away from what Steadfast reports.
export const COURIER_OWNED_STATUSES: OrderStatusValue[] = ["IN_TRANSIT", "DELIVERED", "PARTIAL_DELIVERED", "RETURNED"];

export function isTransitionAllowed(from: OrderStatusValue, to: OrderStatusValue): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextLegalStatuses(from: OrderStatusValue): OrderStatusValue[] {
  return ORDER_TRANSITIONS[from] ?? [];
}

/** What the generic status-change UI/route may offer — the legal graph edges minus the ones reserved for a dedicated flow. */
export function nextSelectableStatuses(from: OrderStatusValue): OrderStatusValue[] {
  return nextLegalStatuses(from).filter((s) => !STATUSES_REQUIRING_DEDICATED_FLOW.includes(s));
}
