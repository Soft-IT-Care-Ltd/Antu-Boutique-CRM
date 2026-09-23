import type { Prisma, StockReferenceType } from "@prisma/client";

import { fromPaisa, toPaisa } from "./costing";
import { WRITE_OFF_EXPENSE_CATEGORY } from "./constants";
import { lockVariant, recordStockMovement, StockMovementError } from "./ledger";

// PRD §4.3: manual adjustment (reason required, Admin/Manager only — the
// route gates on inventory.adjust) and damage write-off (DAMAGE_OUT + an
// expense line at cost). Both value the movement at the variant's current
// weighted average cost, read under a row lock.

export { StockMovementError };

export type StockChangeRequest = { variantId: string; qty: number; reason: string };

/** Signed manual correction (+ found / − missing). Can never take on-hand stock below zero. */
export async function adjustStock(tx: Prisma.TransactionClient, input: StockChangeRequest, actorId: string) {
  const reason = input.reason.trim();
  if (!reason) throw new StockMovementError("A reason is required for a stock adjustment");

  const locked = await lockVariant(tx, input.variantId);
  if (!locked) throw new StockMovementError("Variant not found");
  if (locked.stockQty + input.qty < 0) {
    throw new StockMovementError(`Only ${locked.stockQty} on hand — can't remove ${Math.abs(input.qty)}`);
  }

  return recordStockMovement(tx, {
    variantId: input.variantId,
    type: "ADJUSTMENT",
    qty: input.qty,
    unitCost: locked.weightedAvgCost,
    referenceType: "ADJUSTMENT",
    actorId,
    note: reason,
  });
}

export type WriteOffOptions = {
  /**
   * Value the units at this cost instead of the current weighted average —
   * returned goods are written off at the unit_cost_snapshot they left with,
   * so the write-off matches the RETURN_IN that just put them back.
   */
  unitCost?: Prisma.Decimal;
  referenceType?: StockReferenceType;
  referenceId?: string | null;
};

/** Takes `qty` (positive) damaged units off the shelf and books their cost as an expense, atomically. */
export async function writeOffDamagedStock(tx: Prisma.TransactionClient, input: StockChangeRequest, actorId: string | null, options: WriteOffOptions = {}) {
  const reason = input.reason.trim();
  if (!reason) throw new StockMovementError("A reason is required for a write-off");
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new StockMovementError("Write-off quantity must be a positive whole number");

  const locked = await lockVariant(tx, input.variantId);
  if (!locked) throw new StockMovementError("Variant not found");
  if (input.qty > locked.stockQty) {
    throw new StockMovementError(`Only ${locked.stockQty} on hand — can't write off ${input.qty}`);
  }

  const unitCost = options.unitCost ?? locked.weightedAvgCost;
  const movement = await recordStockMovement(tx, {
    variantId: input.variantId,
    type: "DAMAGE_OUT",
    qty: -input.qty,
    unitCost,
    referenceType: options.referenceType ?? "DAMAGE",
    referenceId: options.referenceId ?? null,
    actorId,
    note: reason,
  });

  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: input.variantId }, select: { sku: true } });
  const category = await tx.expenseCategory.upsert({
    where: { name: WRITE_OFF_EXPENSE_CATEGORY },
    update: {},
    create: { name: WRITE_OFF_EXPENSE_CATEGORY, sortOrder: 10 },
  });

  const expense = await tx.expense.create({
    data: {
      expenseDate: movement.createdAt,
      categoryId: category.id,
      nature: "VARIABLE",
      amount: fromPaisa(toPaisa(unitCost) * input.qty),
      note: `Write-off: ${input.qty} × ${variant.sku} — ${reason}`,
      stockMovementId: movement.id,
      createdById: actorId,
    },
  });

  return { movement, expense };
}
