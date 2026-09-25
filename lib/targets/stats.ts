import type { OrderStatusValue } from "@/lib/orders/constants";
import { DELIVERED_STATUSES, RETURNED_STATUSES } from "@/lib/targets/constants";

// Pure month-performance arithmetic, in paisa (CLAUDE.md: money never as a
// float). Client- and server-safe so the numbers are unit-tested directly.

export type StatusBucket = { status: OrderStatusValue; totalPaisa: number; count: number };

export type Stats = {
  /** Orders placed in the month that still count as sales (not cancelled, not returned). */
  salesPaisa: number;
  orderCount: number;
  /** The part of those that reached the customer. */
  deliveredPaisa: number;
  delivered: number;
  returned: number;
  /** Confirmed, packed, with the courier or on hold — no outcome yet. */
  inProgress: number;
  /** delivered ÷ (delivered + returned), 0–1; null until one has an outcome. */
  deliveredRate: number | null;
};

const isDelivered = (s: OrderStatusValue) => (DELIVERED_STATUSES as readonly OrderStatusValue[]).includes(s);
const isReturned = (s: OrderStatusValue) => (RETURNED_STATUSES as readonly OrderStatusValue[]).includes(s);

export const EMPTY_STATS: Stats = { salesPaisa: 0, orderCount: 0, deliveredPaisa: 0, delivered: 0, returned: 0, inProgress: 0, deliveredRate: null };

/** Folds one subject's orders, grouped by status, into its month stats. Callers pass sale statuses only. */
export function statsFromBuckets(buckets: StatusBucket[]): Stats {
  const s = { ...EMPTY_STATS };
  for (const b of buckets) {
    if (isReturned(b.status)) {
      s.returned += b.count;
      continue;
    }
    s.salesPaisa += b.totalPaisa;
    s.orderCount += b.count;
    if (isDelivered(b.status)) {
      s.delivered += b.count;
      s.deliveredPaisa += b.totalPaisa;
    } else {
      s.inProgress += b.count;
    }
  }
  const finished = s.delivered + s.returned;
  s.deliveredRate = finished > 0 ? s.delivered / finished : null;
  return s;
}

/** Share of a goal reached, 0+ (can pass 1); null when there is no goal. */
export function progressRatio(achieved: number, goal: number | null | undefined): number | null {
  if (!goal || goal <= 0) return null;
  return achieved / goal;
}

/**
 * What's still needed per remaining day (today included) to reach the goal;
 * 0 once reached, null when there is no goal or no day left.
 */
export function perDayNeeded(achieved: number, goal: number | null | undefined, daysLeft: number): number | null {
  if (!goal || goal <= 0 || daysLeft <= 0) return null;
  return Math.max(0, Math.ceil((goal - achieved) / daysLeft));
}
