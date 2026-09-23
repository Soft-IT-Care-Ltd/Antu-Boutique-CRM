import type { CostAllocationMethod, Prisma } from "@prisma/client";

import { costPurchase, computeWeightedAverageCostPaisa, fromPaisa, toPaisa } from "./costing";
import { lockVariant, recordStockMovement } from "./ledger";

// PRD §4.3 purchase entry. Like ledger.ts, acts only through the caller's
// transaction client (no "server-only", no prisma singleton) so the seed
// script posts demo purchases through this exact code path.

export class PurchaseError extends Error {}

export type CreatePurchaseInput = {
  supplierId: string;
  purchaseDate: Date;
  invoiceNo?: string | null;
  allocationMethod: CostAllocationMethod;
  transportCost: string | number;
  otherCost: string | number;
  amountPaid: string | number;
  note?: string | null;
  items: { variantId: string; qty: number; unitCost: string | number }[];
};

/** Supplier due is always derived, never typed (same principle as order.due_amount). */
export function computePurchaseDue(totalCost: string | number | { toString(): string }, amountPaid: string | number | { toString(): string }): string {
  return fromPaisa(toPaisa(totalCost) - toPaisa(amountPaid));
}

/**
 * Saves a purchase and, for every line, in ONE transaction:
 *   1. locks the variant row (FOR UPDATE),
 *   2. recomputes its weighted average cost from the landed unit cost —
 *      new_wac = (old_qty × old_wac + in_qty × in_cost) ÷ (old_qty + in_qty),
 *   3. posts a PURCHASE_IN ledger row (which moves stockQty).
 * Lines are processed in variantId order so two concurrent purchases that
 * share variants always lock them in the same order (no deadlock).
 */
export async function createPurchase(tx: Prisma.TransactionClient, input: CreatePurchaseInput, actorId: string | null) {
  if (input.items.length === 0) throw new PurchaseError("A purchase needs at least one item");

  const variantIds = input.items.map((i) => i.variantId);
  if (new Set(variantIds).size !== variantIds.length) {
    throw new PurchaseError("The same variant appears twice — combine it into one line");
  }

  const variants = await tx.productVariant.findMany({
    where: { id: { in: variantIds }, product: { deletedAt: null } },
    select: { id: true },
  });
  if (variants.length !== variantIds.length) throw new PurchaseError("One of the selected variants no longer exists");

  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } });
  if (!supplier) throw new PurchaseError("Supplier not found");

  const costed = costPurchase(input.items, input.transportCost, input.otherCost, input.allocationMethod);
  const amountPaidPaisa = toPaisa(input.amountPaid);
  if (amountPaidPaisa > costed.totalCostPaisa) throw new PurchaseError("Amount paid can't be more than the purchase total");

  const invoiceNo = input.invoiceNo?.trim() || null;
  const purchase = await tx.purchase.create({
    data: {
      supplierId: input.supplierId,
      purchaseDate: input.purchaseDate,
      invoiceNo,
      allocationMethod: input.allocationMethod,
      itemsSubtotal: fromPaisa(costed.itemsSubtotalPaisa),
      transportCost: fromPaisa(toPaisa(input.transportCost)),
      otherCost: fromPaisa(toPaisa(input.otherCost)),
      totalCost: fromPaisa(costed.totalCostPaisa),
      amountPaid: fromPaisa(amountPaidPaisa),
      dueAmount: fromPaisa(costed.totalCostPaisa - amountPaidPaisa),
      note: input.note?.trim() || null,
      createdById: actorId,
    },
  });

  const processingOrder = input.items.map((_, i) => i).sort((a, b) => input.items[a].variantId.localeCompare(input.items[b].variantId));

  for (const i of processingOrder) {
    const item = input.items[i];
    const line = costed.lines[i];

    const locked = await lockVariant(tx, item.variantId);
    if (!locked) throw new PurchaseError("One of the selected variants no longer exists");

    const wacBeforePaisa = toPaisa(locked.weightedAvgCost);
    const wacAfterPaisa = computeWeightedAverageCostPaisa(locked.stockQty, wacBeforePaisa, item.qty, line.landedUnitCostPaisa);

    await tx.productVariant.update({ where: { id: item.variantId }, data: { weightedAvgCost: fromPaisa(wacAfterPaisa) } });

    await recordStockMovement(tx, {
      variantId: item.variantId,
      type: "PURCHASE_IN",
      qty: item.qty,
      unitCost: fromPaisa(line.landedUnitCostPaisa),
      referenceType: "PURCHASE",
      referenceId: purchase.id,
      actorId,
      note: invoiceNo ? `Supplier invoice ${invoiceNo}` : null,
    });

    await tx.purchaseItem.create({
      data: {
        purchaseId: purchase.id,
        variantId: item.variantId,
        qty: item.qty,
        unitCost: fromPaisa(line.unitCostPaisa),
        lineCost: fromPaisa(line.lineCostPaisa),
        allocatedCost: fromPaisa(line.allocatedPaisa),
        landedUnitCost: fromPaisa(line.landedUnitCostPaisa),
        stockBefore: locked.stockQty,
        wacBefore: fromPaisa(wacBeforePaisa),
        wacAfter: fromPaisa(wacAfterPaisa),
      },
    });
  }

  return purchase;
}
