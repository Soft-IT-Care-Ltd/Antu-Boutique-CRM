import "server-only";

import type { Prisma } from "@prisma/client";

import { IllegalTransitionError, moveOrderStatus } from "@/lib/orders/lifecycle";
import { deductVariantStockAtPack } from "@/lib/orders/stock";
import { isTransitionAllowed } from "@/lib/orders/status-graph";
import type { OrderStatusValue } from "@/lib/orders/constants";

export { IllegalTransitionError };

// PRD §4.8 packing checklist — required before PACKED. Every key must be
// `true`; the API route's Zod schema enforces this server-side (CLAUDE.md
// rule 9 — the client's checklist UI is a convenience, not the guarantee).
export const PACKING_CHECKLIST_KEYS = ["itemsMatch", "imageMatched", "qualityChecked", "invoicePrinted"] as const;
export type PackingChecklistKey = (typeof PACKING_CHECKLIST_KEYS)[number];
export type PackingChecklist = Record<PackingChecklistKey, boolean>;

type OrderForPacking = {
  id: string;
  status: OrderStatusValue;
  items: { id: string; variantId: string; qty: number }[];
};

/**
 * The one place an order reaches PACKED (PRD §4.8, CLAUDE.md rule 2 + 3 +
 * 10). For every line: freezes unit_cost_snapshot from the variant's
 * CURRENT weighted average cost (never touched again — rule 3) and deducts
 * real stock with a SALE_OUT ledger row at that same cost (rules 2 + 10), then moves the order to PACKED via the same
 * status-history writer every other transition uses. All of it — item
 * updates, stock deduction, status move — runs in the caller's transaction,
 * so a failure anywhere rolls the whole pack back (rule 2).
 */
export async function packOrder(
  tx: Prisma.TransactionClient,
  order: OrderForPacking,
  packerId: string,
  note?: string | null,
): Promise<void> {
  if (!isTransitionAllowed(order.status, "PACKED")) {
    throw new IllegalTransitionError(order.status, "PACKED");
  }

  for (const item of order.items) {
    const variant = await tx.productVariant.findUniqueOrThrow({
      where: { id: item.variantId },
      select: { weightedAvgCost: true },
    });
    await tx.orderItem.update({
      where: { id: item.id },
      data: { unitCostSnapshot: variant.weightedAvgCost },
    });
    await deductVariantStockAtPack(tx, {
      orderId: order.id,
      variantId: item.variantId,
      qty: item.qty,
      unitCost: variant.weightedAvgCost,
      actorId: packerId,
    });
  }

  await moveOrderStatus(
    tx,
    { id: order.id, status: order.status, items: order.items.map((i) => ({ variantId: i.variantId, qty: i.qty, unitCostSnapshot: null })) },
    "PACKED",
    packerId,
    note,
  );
}
