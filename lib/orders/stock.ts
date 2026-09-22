import "server-only";

import type { Prisma } from "@prisma/client";

// PRD §4.6 section 2 + CLAUDE.md rule 10: stock is reserved at CONFIRMED,
// deducted at PACKED. This form creates orders directly at CONFIRMED (see
// the comment on the Order model), so it owns the reservation half of that
// rule; P1.6 owns the PACKED deduction (an actual stockQty change, which
// per PRD §4.3's stock_movements type list — PURCHASE_IN/SALE_OUT/etc. —
// is the only kind of stock write that needs a ledger row). Bumping
// reservedQty is a counter, not a movement, so it does NOT need one.
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
// a ledger row." Stock isn't actually deducted at PACKED until P1.6 ships
// (this codebase can't reach PACKED yet — see the comment on OrderStatus),
// so no order can hit this path today. It's wired now, alongside
// reserve/releaseVariantStock, so P1.6/Phase 2 only has to swap the
// increment below for a stock_movements row in the same transaction —
// nothing in lib/orders/lifecycle.ts has to change.
export async function restoreVariantStockAfterPack(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number,
): Promise<void> {
  if (qty === 0) return;
  await tx.productVariant.update({
    where: { id: variantId },
    data: { stockQty: { increment: qty } },
  });
}

// PRD §4.8 + CLAUDE.md rule 10: stock is deducted at PACKED. The qty was
// already reserved at CONFIRMED (reserveVariantStock), so packing both
// converts that reservation into a real deduction (reservedQty down) and
// removes the stock from the shelf (stockQty down) — mirrored exactly by
// restoreVariantStockAfterPack's stockQty-only increment on a later
// CANCELLED (reservedQty is already zero for a packed item by then).
// stock_movements doesn't exist until Phase 2 (P2.1) — see the comment on
// restoreVariantStockAfterPack above; this is the other half of the same
// stub, called from lib/orders/pack.ts inside the same transaction as the
// PACKED status move (CLAUDE.md rule 2's "no stock write without a ledger
// row" is honoured retroactively the moment P2.1 adds the ledger, since
// this function is the only place either counter changes at PACKED).
export async function deductVariantStockAtPack(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number,
): Promise<void> {
  if (qty === 0) return;
  await tx.productVariant.update({
    where: { id: variantId },
    data: { stockQty: { decrement: qty }, reservedQty: { decrement: qty } },
  });
}
