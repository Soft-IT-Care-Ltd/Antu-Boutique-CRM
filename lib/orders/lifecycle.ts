import "server-only";

import type { Prisma } from "@prisma/client";

import { releaseVariantStock, restoreVariantStockAfterPack } from "@/lib/orders/stock";
import { openReturnInspection } from "@/lib/returns/condition-check";
import { isTransitionAllowed } from "@/lib/orders/status-graph";
import type { OrderStatusValue } from "@/lib/orders/constants";

export {
  COURIER_OWNED_STATUSES,
  isTransitionAllowed,
  nextLegalStatuses,
  nextSelectableStatuses,
  STATUSES_REQUIRING_DEDICATED_FLOW,
} from "@/lib/orders/status-graph";

type OrderWithItemsForMove = {
  id: string;
  status: OrderStatusValue;
  items: { variantId: string; qty: number; unitCostSnapshot: Prisma.Decimal | null }[];
};

export class IllegalTransitionError extends Error {
  constructor(from: OrderStatusValue, to: OrderStatusValue, message = `Cannot move an order from ${from} to ${to}`) {
    super(message);
  }
}

/** The order was no longer at the status the caller read — someone else moved it first. */
export class StaleOrderStatusError extends IllegalTransitionError {
  constructor(from: OrderStatusValue, to: OrderStatusValue) {
    super(from, to, `This order is no longer ${from} — someone else just changed it. Reload and try again.`);
  }
}

/**
 * The one place an order's status is allowed to change. Validates the move
 * against ORDER_TRANSITIONS, applies the CANCELLED stock side-effect (PRD
 * §4.6: release the reservation if the order was never packed, restore
 * stock if it was), writes the order_status_history row, and returns the
 * updated order. Must run inside the caller's transaction.
 *
 * The move is claimed atomically (UPDATE … WHERE status = from): if a
 * concurrent move got there first — two packers, pack vs cancel, a replayed
 * webhook — this throws StaleOrderStatusError and the caller's whole
 * transaction rolls back, including any stock it already moved.
 */
export async function moveOrderStatus(
  tx: Prisma.TransactionClient,
  order: OrderWithItemsForMove,
  toStatus: OrderStatusValue,
  /** null = the system (courier webhook / poll) — shown as "System" in history. */
  changedById: string | null,
  note?: string | null,
): Promise<void> {
  const fromStatus = order.status;
  if (!isTransitionAllowed(fromStatus, toStatus)) {
    throw new IllegalTransitionError(fromStatus, toStatus);
  }

  const claimed = await tx.order.updateMany({ where: { id: order.id, status: fromStatus }, data: { status: toStatus } });
  if (claimed.count !== 1) throw new StaleOrderStatusError(fromStatus, toStatus);

  if (toStatus === "CANCELLED") {
    // Read the lines under the claim, not the caller's copy: what was
    // packed (unitCostSnapshot set) decides restock vs release.
    const items = await tx.orderItem.findMany({ where: { orderId: order.id }, select: { variantId: true, qty: true, unitCostSnapshot: true } });
    for (const item of items) {
      // unitCostSnapshot is only ever set at PACKED (CLAUDE.md rule 3) — its
      // presence is the signal that stock was deducted, not just reserved.
      if (item.unitCostSnapshot !== null) {
        await restoreVariantStockAfterPack(tx, {
          orderId: order.id,
          variantId: item.variantId,
          qty: item.qty,
          unitCostSnapshot: item.unitCostSnapshot,
          actorId: changedById,
        });
      } else {
        await releaseVariantStock(tx, item.variantId, item.qty);
      }
    }
  }

  await tx.orderStatusHistory.create({
    data: { orderId: order.id, fromStatus, toStatus, changedById, note: note || null },
  });

  // PRD §4.9 / §4.11: goods coming back are never restocked on the status
  // move itself — a Packing condition check decides Good vs Damaged. Any
  // path into RETURNED (courier sync or a manual move) opens that task;
  // PARTIAL_DELIVERED opens it one step earlier, waiting for staff to mark
  // which items the customer kept.
  if (toStatus === "RETURNED") {
    const courierLeg: OrderStatusValue[] = ["HANDED_TO_COURIER", "IN_TRANSIT", "ON_HOLD"];
    await openReturnInspection(tx, {
      orderId: order.id,
      source: courierLeg.includes(fromStatus) ? "COURIER_RETURN" : "CUSTOMER_RETURN",
    });
  } else if (toStatus === "PARTIAL_DELIVERED") {
    await openReturnInspection(tx, { orderId: order.id, source: "PARTIAL_DELIVERY" });
  }
}
