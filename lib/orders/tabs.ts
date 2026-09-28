import type { OrderStatusValue } from "@/lib/orders/constants";

// CORRECTIONS.md item 14 — the Orders page's status navigation: tabs with
// counts, sub-tabs where useful. Client- and server-safe: the page draws
// the tabs from this list, and the API (lib/orders/list-where.ts
// orderTabWhere) builds each tab's where from the same definitions, so a
// tab's count and its rows can't disagree.
//
// Open-work tabs show every open order whatever the date filter says, so
// nothing pending is hidden; finished tabs follow the date filter.
//
// "Waiting for stock" and "Needs transfer" are fulfilment states, not
// order statuses: they need per-location stock (C3) and backorders (C5).
// Until then every confirmed order is "Ready to pack" (exactly the packing
// queue) and those two tabs are empty — C5 fills them from the automatic
// fulfilment status without changing the tab bar.

export const ORDER_TAB_KEYS = [
  "needs_confirmation",
  "waiting_for_stock",
  "needs_transfer",
  "ready_to_pack",
  "on_hold",
  "packed",
  "with_courier",
  "delivered",
  "completed",
  "returns",
  "cancelled",
  "all",
] as const;
export type OrderTabKey = (typeof ORDER_TAB_KEYS)[number];

export const ORDER_SUB_TAB_KEYS = ["handed_over", "in_transit", "approval_pending", "returned", "exchange"] as const;
export type OrderSubTabKey = (typeof ORDER_SUB_TAB_KEYS)[number];

export type OrderSubTab = { key: OrderSubTabKey; label: string };

export type OrderTab = {
  key: OrderTabKey;
  label: string;
  /** Open work ignores the date filter; finished tabs follow it. */
  open: boolean;
  /** The order statuses the tab covers (the "all" tab covers every one). */
  statuses: OrderStatusValue[] | "all";
  subTabs?: OrderSubTab[];
  /** Shown on the empty tab. */
  emptyHint?: string;
};

export const ORDER_TABS: OrderTab[] = [
  { key: "needs_confirmation", label: "Needs confirmation", open: true, statuses: ["LEAD"] },
  {
    key: "waiting_for_stock",
    label: "Waiting for stock",
    open: true,
    statuses: ["CONFIRMED"],
    emptyHint: "Orders with an item that isn't in stock anywhere land here once backorders are switched on.",
  },
  {
    key: "needs_transfer",
    label: "Needs transfer",
    open: true,
    statuses: ["CONFIRMED"],
    emptyHint: "Orders whose items sit at another location land here once stock is kept per location.",
  },
  { key: "ready_to_pack", label: "Ready to pack", open: true, statuses: ["CONFIRMED"] },
  // Not in the owner's list, but an order on hold is open work and must not vanish from every tab.
  { key: "on_hold", label: "On hold", open: true, statuses: ["ON_HOLD"] },
  { key: "packed", label: "Packed", open: true, statuses: ["PACKED"] },
  {
    key: "with_courier",
    label: "With courier",
    open: true,
    statuses: ["HANDED_TO_COURIER", "IN_TRANSIT"],
    subTabs: [
      { key: "handed_over", label: "Handed over" },
      { key: "in_transit", label: "In transit" },
      { key: "approval_pending", label: "Approval pending" },
    ],
  },
  { key: "delivered", label: "Delivered", open: false, statuses: ["DELIVERED", "PARTIAL_DELIVERED"] },
  { key: "completed", label: "Completed", open: false, statuses: ["COMPLETED"] },
  {
    key: "returns",
    label: "Returns & exchanges",
    open: false,
    statuses: ["RETURNED", "REFUNDED", "EXCHANGE_REQUESTED"],
    subTabs: [
      { key: "returned", label: "Returns" },
      { key: "exchange", label: "Exchanges" },
    ],
  },
  { key: "cancelled", label: "Cancelled", open: false, statuses: ["CANCELLED"] },
  { key: "all", label: "All", open: false, statuses: "all" },
];

export const ORDER_TAB_BY_KEY = Object.fromEntries(ORDER_TABS.map((t) => [t.key, t])) as Record<OrderTabKey, OrderTab>;

/** The tab a status is shown under (a dashboard link to ?status=X opens it). */
export function tabForStatus(status: OrderStatusValue): { tab: OrderTabKey; sub?: OrderSubTabKey } {
  switch (status) {
    case "CONFIRMED":
      return { tab: "ready_to_pack" };
    case "HANDED_TO_COURIER":
      return { tab: "with_courier", sub: "handed_over" };
    case "IN_TRANSIT":
      return { tab: "with_courier" };
    case "RETURNED":
    case "REFUNDED":
      return { tab: "returns", sub: "returned" };
    case "EXCHANGE_REQUESTED":
      return { tab: "returns", sub: "exchange" };
  }
  const tab = ORDER_TABS.find((t) => t.statuses !== "all" && t.statuses.includes(status) && t.key !== "waiting_for_stock" && t.key !== "needs_transfer");
  return { tab: tab?.key ?? "all" };
}

export type OrderTabCounts = { tabs: Record<OrderTabKey, number>; subTabs: Partial<Record<OrderSubTabKey, number>> };
