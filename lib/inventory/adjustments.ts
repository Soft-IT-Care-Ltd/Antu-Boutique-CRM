import type { Expense, Prisma, StockMovement, StockReferenceType } from "@prisma/client";

import { fromPaisa, toPaisa } from "./costing";
import { SHORTAGE_EXPENSE_CATEGORY, SHORTAGE_EXPENSE_CATEGORY_ID, WRITE_OFF_EXPENSE_CATEGORY, WRITE_OFF_EXPENSE_CATEGORY_ID } from "./constants";
import { lockVariantAt, recordStockMovement, StockMovementError } from "./ledger";
import type { ShelfPick } from "../shelves/engine";

// PRD §4.3: manual adjustment (reason required, Admin/Manager only — the
// route gates on inventory.adjust) and damage write-off (DAMAGE_OUT). Both
// value the movement at the variant's current weighted average cost, read
// under a row lock, and post its cost as an expense in the same
// transaction (PRD §4.12): a write-off under "Damage / write-off", an
// adjustment under "Stock shortage" — a shortfall as a cost, stock found as
// a credit, so that heading shows the net unexplained loss.

export { StockMovementError };

/** C3 — every adjustment and write-off happens at one location. */
export type StockChangeRequest = { variantId: string; locationId: string; qty: number; reason: string };

const STOCK_EXPENSE_CATEGORIES = {
  DAMAGE: { id: WRITE_OFF_EXPENSE_CATEGORY_ID, name: WRITE_OFF_EXPENSE_CATEGORY, kind: "DAMAGE_WRITE_OFF" },
  SHORTAGE: { id: SHORTAGE_EXPENSE_CATEGORY_ID, name: SHORTAGE_EXPENSE_CATEGORY, kind: "STOCK_SHORTAGE" },
} as const;

/**
 * Books a stock movement's cost as a non-cash expense (no wallet): the
 * units that left the shelf cost `−qty × unitCost` — positive for stock out,
 * a credit for stock found. Nothing is posted when that is zero (a variant
 * with no cost yet); the DB refuses a zero expense.
 */
export async function postStockExpense(tx: Prisma.TransactionClient, movement: StockMovement, kind: keyof typeof STOCK_EXPENSE_CATEGORIES, note: string, actorId: string | null): Promise<Expense | null> {
  const paisa = -movement.qty * toPaisa(movement.unitCostSnapshot);
  if (paisa === 0) return null;
  const c = STOCK_EXPENSE_CATEGORIES[kind];
  const category = await tx.expenseCategory.upsert({
    where: { id: c.id },
    update: {},
    create: { id: c.id, name: c.name, sortOrder: 10, kind: c.kind, isSystem: true },
  });
  return tx.expense.create({
    data: {
      expenseDate: movement.createdAt,
      categoryId: category.id,
      nature: "VARIABLE",
      amount: fromPaisa(paisa),
      note,
      stockMovementId: movement.id,
      createdById: actorId,
    },
  });
}

/**
 * Signed manual correction (+ found / − missing) at one location, with its
 * "Stock shortage" expense. Can never take that location below zero — but
 * a location already negative (a POS sale, item 11) can be brought back up.
 */
export async function adjustStock(
  tx: Prisma.TransactionClient,
  input: StockChangeRequest,
  actorId: string,
  /** C4 — a stock count posts its differences as adjustments pointing back at the count. */
  options: { referenceType?: StockReferenceType; referenceId?: string | null; fromShelves?: ShelfPick[] } = {},
) {
  const reason = input.reason.trim();
  if (!reason) throw new StockMovementError("A reason is required for a stock adjustment");

  const locked = await lockVariantAt(tx, input.variantId, input.locationId);
  if (!locked) throw new StockMovementError("Variant not found");
  if (input.qty < 0 && locked.locationQty + input.qty < 0) {
    throw new StockMovementError(`Only ${Math.max(0, locked.locationQty)} on hand at this location — can't remove ${Math.abs(input.qty)}`);
  }

  const movement = await recordStockMovement(tx, {
    variantId: input.variantId,
    locationId: input.locationId,
    type: "ADJUSTMENT",
    qty: input.qty,
    unitCost: locked.weightedAvgCost,
    referenceType: options.referenceType ?? "ADJUSTMENT",
    referenceId: options.referenceId ?? null,
    actorId,
    note: reason,
    fromShelves: options.fromShelves,
  });

  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: input.variantId }, select: { sku: true } });
  const what = input.qty < 0 ? `Stock shortage: ${-input.qty}` : `Stock found: ${input.qty}`;
  const expense = await postStockExpense(tx, movement, "SHORTAGE", `${what} × ${variant.sku} — ${reason}`, actorId);
  return { movement, expense };
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
  /** C4b — the shelf the damaged units were taken off, when known. */
  fromShelves?: ShelfPick[];
};

/** Takes `qty` (positive) damaged units off the shelf and books their cost as an expense, atomically. */
export async function writeOffDamagedStock(tx: Prisma.TransactionClient, input: StockChangeRequest, actorId: string | null, options: WriteOffOptions = {}) {
  const reason = input.reason.trim();
  if (!reason) throw new StockMovementError("A reason is required for a write-off");
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new StockMovementError("Write-off quantity must be a positive whole number");

  const locked = await lockVariantAt(tx, input.variantId, input.locationId);
  if (!locked) throw new StockMovementError("Variant not found");
  if (input.qty > locked.locationQty) {
    throw new StockMovementError(`Only ${Math.max(0, locked.locationQty)} on hand at this location — can't write off ${input.qty}`);
  }

  const unitCost = options.unitCost ?? locked.weightedAvgCost;
  const movement = await recordStockMovement(tx, {
    variantId: input.variantId,
    locationId: input.locationId,
    type: "DAMAGE_OUT",
    qty: -input.qty,
    unitCost,
    referenceType: options.referenceType ?? "DAMAGE",
    referenceId: options.referenceId ?? null,
    actorId,
    note: reason,
    fromShelves: options.fromShelves,
  });

  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: input.variantId }, select: { sku: true } });
  const expense = await postStockExpense(tx, movement, "DAMAGE", `Write-off: ${input.qty} × ${variant.sku} — ${reason}`, actorId);

  return { movement, expense };
}
