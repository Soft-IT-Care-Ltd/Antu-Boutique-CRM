import "server-only";

import type { Prisma } from "@prisma/client";

import { recordStockMovement } from "@/lib/inventory/ledger";

// PRD §4.6 section 2 + CLAUDE.md rule 10: stock is reserved at CONFIRMED,
// deducted at PACKED. This form creates orders directly at CONFIRMED (see
// the comment on the Order model), so it owns the reservation half of that
// rule; P1.6 owns the PACKED deduction (an actual stockQty change, which
// goes through lib/inventory/ledger.ts like every other stock write).
// Bumping reservedQty is a counter, not a movement — PRD §4.3's
// stock_movements types have no RESERVE — so it does NOT write a ledger row.
//
// Must be called with a transaction client so the reservation commits
// atomically with the order/order-items it belongs to.
export async function reserveVariantStock(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number,
): Promise<void> {
  if (qty === 0) return;
  await tx.productVariant.update({
    where: { id: variantId },
    data: { reservedQty: { increment: qty } },
  });
}

export async function releaseVariantStock(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number,
): Promise<void> {
  if (qty === 0) return;
  await tx.productVariant.update({
    where: { id: variantId },
    data: { reservedQty: { decrement: qty } },
  });
}

// PRD §4.6 + CLAUDE.md rule 2: "cancelling after PACKED restores stock via
// a ledger row." Goes back on the shelf as RETURN_IN at the cost it left
// with (the line's frozen unitCostSnapshot), so the ledger's value in
// matches its value out. reservedQty is untouched: it was already released
// when the line was packed.
export async function restoreVariantStockAfterPack(
  tx: Prisma.TransactionClient,
  input: { orderId: string; variantId: string; qty: number; unitCostSnapshot: Prisma.Decimal; actorId: string | null },
): Promise<void> {
  if (input.qty === 0) return;
  await recordStockMovement(tx, {
    variantId: input.variantId,
    type: "RETURN_IN",
    qty: input.qty,
    unitCost: input.unitCostSnapshot,
    referenceType: "ORDER",
    referenceId: input.orderId,
    actorId: input.actorId,
    note: "Order cancelled after packing — restocked",
  });
}

// PRD §4.8 + CLAUDE.md rule 10: stock is deducted at PACKED. The qty was
// already reserved at CONFIRMED (reserveVariantStock), so packing both
// converts that reservation into a real deduction (reservedQty down) and
// removes the stock from the shelf (stockQty down, as a SALE_OUT ledger row
// valued at the same cost that was just frozen into unitCostSnapshot).
// Called from lib/orders/pack.ts inside the same transaction as the PACKED
// status move.
export async function deductVariantStockAtPack(
  tx: Prisma.TransactionClient,
  input: { orderId: string; variantId: string; qty: number; unitCost: Prisma.Decimal; actorId: string },
): Promise<void> {
  if (input.qty === 0) return;
  await recordStockMovement(tx, {
    variantId: input.variantId,
    type: "SALE_OUT",
    qty: -input.qty,
    unitCost: input.unitCost,
    referenceType: "ORDER",
    referenceId: input.orderId,
    actorId: input.actorId,
    releaseReserved: input.qty,
  });
}
