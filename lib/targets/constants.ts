// PRD §4.13 — targets, rewards, leaderboard. Client- and server-safe (no
// Prisma import), mirrored from the RewardScope / RewardMetric enums.

import type { OrderStatusValue } from "@/lib/orders/constants";

export const REWARD_SCOPE_VALUES = ["INDIVIDUAL", "TEAM"] as const;
export type RewardScopeValue = (typeof REWARD_SCOPE_VALUES)[number];

export const REWARD_SCOPE_LABELS: Record<RewardScopeValue, string> = {
  INDIVIDUAL: "Each person",
  TEAM: "Each team",
};

export const REWARD_METRIC_VALUES = ["VALUE_TARGET_PERCENT", "COUNT_TARGET_PERCENT", "SALES_VALUE", "DELIVERED_VALUE", "ORDER_COUNT"] as const;
export type RewardMetricValue = (typeof REWARD_METRIC_VALUES)[number];

export const REWARD_METRIC_LABELS: Record<RewardMetricValue, string> = {
  VALUE_TARGET_PERCENT: "% of value target",
  COUNT_TARGET_PERCENT: "% of order-count target",
  SALES_VALUE: "Order value",
  DELIVERED_VALUE: "Delivered value",
  ORDER_COUNT: "Orders",
};

/** How a threshold for this measure is written and read. */
export const REWARD_METRIC_UNIT: Record<RewardMetricValue, "percent" | "money" | "count"> = {
  VALUE_TARGET_PERCENT: "percent",
  COUNT_TARGET_PERCENT: "percent",
  SALES_VALUE: "money",
  DELIVERED_VALUE: "money",
  ORDER_COUNT: "count",
};

// Which orders count, and how. A month's orders are the ones placed in it
// (Dhaka time), not deleted, and not an exchange's replacement order — an
// exchange is not a new sale (PRD §4.11, P3.2 decisions). Order totals
// already drop by anything returned, so a partial return lowers the value
// by exactly what came back.

/** Never a sale: not confirmed yet, or called off before it went out. */
export const NOT_A_SALE_STATUSES = ["LEAD", "CANCELLED"] as const satisfies readonly OrderStatusValue[];

/** Came back: counted for quality, but not toward value or order count. */
export const RETURNED_STATUSES = ["RETURNED", "REFUNDED"] as const satisfies readonly OrderStatusValue[];

/** Reached the customer (an exchange or a partial return still delivered). */
export const DELIVERED_STATUSES = ["DELIVERED", "COMPLETED", "PARTIAL_DELIVERED", "EXCHANGE_REQUESTED"] as const satisfies readonly OrderStatusValue[];

export const LEADERBOARD_SORTS = ["value", "delivered", "orders"] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];

export const LEADERBOARD_SORT_LABELS: Record<LeaderboardSort, string> = {
  value: "Order value",
  delivered: "Delivered value",
  orders: "Orders",
};

/**
 * Below this share of finished orders delivered, the leaderboard flags the
 * row. Reward rules carry their own floor (minDeliveredRate).
 */
export const QUALITY_WARNING_RATE = 0.8;

/** Largest order-value target / reward amount accepted, in taka. */
export const MAX_TARGET_VALUE = 100_000_000;
