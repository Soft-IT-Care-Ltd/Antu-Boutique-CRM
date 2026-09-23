export const ORDER_CHANNEL_VALUES = ["ONLINE", "WALK_IN"] as const;
export type OrderChannelValue = (typeof ORDER_CHANNEL_VALUES)[number];

// P1.3 only ever writes LEAD/CONFIRMED — see prisma/schema.prisma's comment
// on OrderStatus. The full funnel is listed here so the status-history
// timeline and any future status badge can render every value without a
// follow-up change.
export const ORDER_STATUS_VALUES = [
  "LEAD",
  "CONFIRMED",
  "PACKED",
  "HANDED_TO_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "ON_HOLD",
  "CANCELLED",
  "RETURNED",
  "REFUNDED",
  "EXCHANGE_REQUESTED",
  "PARTIAL_DELIVERED",
] as const;
export type OrderStatusValue = (typeof ORDER_STATUS_VALUES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatusValue, string> = {
  LEAD: "Lead",
  CONFIRMED: "Confirmed",
  PACKED: "Packed",
  HANDED_TO_COURIER: "Handed to courier",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  COMPLETED: "Completed",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  REFUNDED: "Refunded",
  EXCHANGE_REQUESTED: "Exchange requested",
  PARTIAL_DELIVERED: "Partially delivered",
};

export const DELIVERY_ZONE_VALUES = ["INSIDE_CITY", "SUB_CITY", "OUTSIDE_CITY"] as const;
export type DeliveryZoneValue = (typeof DELIVERY_ZONE_VALUES)[number];

export const DELIVERY_ZONE_LABELS: Record<DeliveryZoneValue, string> = {
  // PRD §4.9's inside city / sub-city / outside city, named for the
  // showroom's city — the same three tiers Steadfast bills by.
  INSIDE_CITY: "Inside Dhaka",
  SUB_CITY: "Sub Dhaka",
  OUTSIDE_CITY: "Outside Dhaka",
};

export const PAYMENT_METHOD_VALUES = ["BKASH", "NAGAD", "ROCKET", "BANK", "CASH", "CARD"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHOD_VALUES)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodValue, string> = {
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
  BANK: "Bank",
  CASH: "Cash",
  CARD: "Card",
};

// PRD §4.10 names these as the wallets in use; the full Wallet master with
// running balances is Phase 2, so for now `payment.wallet` is free text and
// this is only suggestions for the input (see components/orders/order-payment-dialog.tsx).
export const PAYMENT_WALLET_SUGGESTIONS = ["bKash Personal", "bKash Merchant", "Nagad", "Bank Account", "Showroom Cash"];

// Statuses the order PATCH route (and the /orders/[id]/edit page) will
// still touch at all. Once an order has moved past CONFIRMED it belongs to
// the packing/courier flow and isn't edited through this form anymore —
// separate from (and checked in addition to) the edit-window/approval gate
// below, which governs *how* an edit within these statuses is applied.
export const DIRECTLY_EDITABLE_STATUSES: OrderStatusValue[] = ["LEAD", "CONFIRMED"];

export const ORDER_EDIT_REQUEST_STATUS_VALUES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type OrderEditRequestStatusValue = (typeof ORDER_EDIT_REQUEST_STATUS_VALUES)[number];

export const ORDER_EDIT_REQUEST_STATUS_LABELS: Record<OrderEditRequestStatusValue, string> = {
  PENDING: "Pending approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

// PRD §4.6 section 3.
export const MAX_ORDER_IMAGES = 5;

export function orderNumberYearMonth(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}
