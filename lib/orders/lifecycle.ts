import "server-only";

import type { Prisma } from "@prisma/client";

import { releaseVariantStock, restoreVariantStockAfterPack } from "@/lib/orders/stock";
import { isTransitionAllowed } from "@/lib/orders/status-graph";
import type { OrderStatusValue } from "@/lib/orders/constants";

export { isTransitionAllowed, nextLegalStatuses, nextSelectableStatuses, STATUSES_REQUIRING_DEDICATED_FLOW } from "@/lib/orders/status-graph";

type OrderWithItemsForMove = {
  id: string;
  status: OrderStatusValue;
  items: { variantId: string; qty: number; unitCostSnapshot: Prisma.Decimal | null }[];
};

export class IllegalTransitionError extends Error {
  constructor(from: OrderStatusValue, to: OrderStatusValue) {
    super(`Cannot move an order from ${from} to ${to}`);
  }
}

/**
 * The one place an order's status is allowed to change. Validates the move
 * against ORDER_TRANSITIONS, applies the CANCELLED stock side-effect (PRD
 * §4.6: release the reservation if the order was never packed, restore
 * stock if it was), writes the order_status_history row, and returns the
 * updated order. Must run inside the caller's transaction.
 */
export async function moveOrderStatus(
  tx: Prisma.TransactionClient,
  order: OrderWithItemsForMove,
  toStatus: OrderStatusValue,
  changedById: string,
  note?: string | null,
): Promise<void> {
  const fromStatus = order.status;
  if (!isTransitionAllowed(fromStatus, toStatus)) {
    throw new IllegalTransitionError(fromStatus, toStatus);
  }

  if (toStatus === "CANCELLED") {
    for (const item of order.items) {
      // unitCostSnapshot is only ever set at PACKED (CLAUDE.md rule 3) — its
      // presence is the signal that stock was deducted, not just reserved.
      if (item.unitCostSnapshot !== null) {
        await restoreVariantStockAfterPack(tx, item.variantId, item.qty);
      } else {
        await releaseVariantStock(tx, item.variantId, item.qty);
      }
    }
  }

  await tx.order.update({ where: { id: order.id }, data: { status: toStatus } });
  await tx.orderStatusHistory.create({
    data: { orderId: order.id, fromStatus, toStatus, changedById, note: note || null },
  });
}
