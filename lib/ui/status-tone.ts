import type { OrderStatusValue } from "@/lib/orders/constants";

// One status → badge tone table for the whole app (design-system
// guidelines/erp-patterns.md, "Status → Badge tone"). Green = done, amber =
// waiting/in flight, red = failed; violet only marks the packing steps.
export type BadgeTone = "default" | "soft" | "success" | "warning" | "info" | "neutral" | "destructive" | "outline";

export const ORDER_STATUS_TONE: Record<OrderStatusValue, BadgeTone> = {
  LEAD: "neutral",
  CONFIRMED: "soft",
  PACKED: "default",
  HANDED_TO_COURIER: "default",
  IN_TRANSIT: "warning",
  DELIVERED: "success",
  COMPLETED: "success",
  ON_HOLD: "warning",
  CANCELLED: "destructive",
  RETURNED: "destructive",
  REFUNDED: "destructive",
  EXCHANGE_REQUESTED: "warning",
  PARTIAL_DELIVERED: "warning",
};

// C4 — stock transfers (CORRECTIONS.md item 3) and stock counts.
export const TRANSFER_STATUS_TONE: Record<"DRAFT" | "IN_TRANSIT" | "RECEIVED" | "RECEIVED_WITH_DIFFERENCE" | "CANCELLED", BadgeTone> = {
  DRAFT: "neutral",
  IN_TRANSIT: "warning",
  RECEIVED: "success",
  RECEIVED_WITH_DIFFERENCE: "destructive",
  CANCELLED: "outline",
};

export const STOCK_COUNT_STATUS_TONE: Record<"OPEN" | "POSTED" | "CANCELLED", BadgeTone> = {
  OPEN: "warning",
  POSTED: "success",
  CANCELLED: "outline",
};
