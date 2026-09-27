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
