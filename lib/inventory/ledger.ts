import { Prisma, type StockMovement, type StockMovementType, type StockReferenceType } from "@prisma/client";

// PRD §4.3 + CLAUDE.md rule 2: the ONLY function in the codebase allowed to
// change product_variants.stockQty. It writes the stock change and its
// stock_movements row through the caller's transaction client, so both
// commit or neither does. The database enforces the same thing from the
// other side (see the deferred constraint trigger in migration
// 20260923081635_stock_ledger_purchases): a transaction that moves stock
// without a matching ledger row — or vice versa — cannot commit.
//
// Deliberately free of "server-only" and of the prisma singleton: it only
// ever acts through the `tx` it is handed, which lets prisma/seed.ts post
// its demo stock through the exact same path as the app.

/** Which way each movement type is allowed to move stock. ADJUSTMENT may go either way. */
export const MOVEMENT_DIRECTION: Record<StockMovementType, 1 | -1 | 0> = {
  PURCHASE_IN: 1,
  RETURN_IN: 1,
  EXCHANGE_IN: 1,
  SALE_OUT: -1,
  EXCHANGE_OUT: -1,
  DAMAGE_OUT: -1,
  POS_SALE_OUT: -1,
  ADJUSTMENT: 0,
};

export class StockMovementError extends Error {}

export type RecordStockMovementInput = {
  variantId: string;
  type: StockMovementType;
  /** Signed: positive puts stock on the shelf, negative takes it off. Never zero. */
  qty: number;
  unitCost: Prisma.Decimal | string | number;
  referenceType: StockReferenceType;
  referenceId?: string | null;
  actorId: string | null;
  note?: string | null;
  /**
   * Also release this many units of reservation in the same UPDATE — used
   * at PACKED, where a CONFIRMED reservation turns into a real deduction.
   */
  releaseReserved?: number;
};

export async function recordStockMovement(tx: Prisma.TransactionClient, input: RecordStockMovementInput): Promise<StockMovement> {
  const { variantId, type, qty } = input;

  if (!Number.isInteger(qty) || qty === 0) {
    throw new StockMovementError(`A stock movement needs a non-zero whole quantity (got ${qty})`);
  }
  const direction = MOVEMENT_DIRECTION[type];
  if (direction !== 0 && Math.sign(qty) !== direction) {
    throw new StockMovementError(`${type} must move stock ${direction > 0 ? "in (positive qty)" : "out (negative qty)"}`);
  }

  const variant = await tx.productVariant.update({
    where: { id: variantId },
    data: {
      stockQty: { increment: qty },
      ...(input.releaseReserved ? { reservedQty: { decrement: input.releaseReserved } } : {}),
    },
    select: { stockQty: true },
  });

  return tx.stockMovement.create({
    data: {
      variantId,
      type,
      qty,
      stockAfter: variant.stockQty,
      unitCostSnapshot: new Prisma.Decimal(input.unitCost.toString()),
      referenceType: input.referenceType,
      referenceId: input.referenceId ?? null,
      actorId: input.actorId,
      note: input.note?.trim() || null,
    },
  });
}

export type LockedVariant = { id: string; stockQty: number; reservedQty: number; weightedAvgCost: Prisma.Decimal };

/**
 * SELECT … FOR UPDATE on one variant. Anything that reads stock/WAC to
 * decide what to write (a purchase recomputing WAC, a write-off valuing
 * stock at cost, an adjustment refusing to go below zero) must take this
 * lock first so a concurrent change can't slip in between read and write.
 */
export async function lockVariant(tx: Prisma.TransactionClient, variantId: string): Promise<LockedVariant | null> {
  const rows = await tx.$queryRaw<LockedVariant[]>`
    SELECT "id", "stockQty", "reservedQty", "weightedAvgCost"
    FROM "product_variants"
    WHERE "id" = ${variantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type StockLedgerDivergence = { variantId: string; sku: string; stockQty: number; ledgerQty: number };

/** Every variant whose stockQty ≠ sum(stock_movements.qty). Should always be empty — the DB trigger makes it so. */
export async function findStockLedgerDivergences(client: Prisma.TransactionClient): Promise<StockLedgerDivergence[]> {
  const rows = await client.$queryRaw<{ variantId: string; sku: string; stockQty: number; ledgerQty: bigint }[]>`
    SELECT v."id" AS "variantId", v."sku", v."stockQty", COALESCE(SUM(m."qty"), 0) AS "ledgerQty"
    FROM "product_variants" v
    LEFT JOIN "stock_movements" m ON m."variantId" = v."id"
    GROUP BY v."id"
    HAVING v."stockQty" <> COALESCE(SUM(m."qty"), 0)
  `;
  return rows.map((r) => ({ ...r, ledgerQty: Number(r.ledgerQty) }));
}
