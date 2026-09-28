import { Prisma, type StockMovement, type StockMovementType, type StockReferenceType } from "@prisma/client";

// PRD §4.3 + CLAUDE.md rule 2: the ONLY function in the codebase allowed to
// change product_variants.stockQty or variant_stocks.qty. It writes the
// stock change and its stock_movements row through the caller's transaction
// client, so both commit or neither does. The database enforces the same
// thing from the other side (deferred constraint triggers in migrations
// 20260923081635_stock_ledger_purchases and 20261003090000_stock_locations):
// a transaction that moves stock without a matching ledger row — or vice
// versa — cannot commit.
//
// C3 (CORRECTIONS.md item 2): stock is held per (variant, location). Every
// movement names its location; it moves that location's variant_stocks row
// AND the variant's total (stockQty, the sum over locations) together. A
// location may go below zero (a POS sale of an item in hand — item 11); the
// callers that must not allow it check first under lockVariantAt.
//
// C4 (CORRECTIONS.md item 3): a transfer's units are IN TRANSIT between
// sending and receiving — counted in the total, at no location. Those rows
// have locationId null and move product_variants.inTransitQty instead of a
// variant_stocks row. Only the three transfer types may do that.
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
  // P3.3 — bags, boxes, tissue and tags used packing an order or at the counter.
  PACKAGING_OUT: -1,
  ADJUSTMENT: 0,
  // C4 — each is half of a pair; the sign depends on the side (below).
  TRANSFER_SEND: 0,
  TRANSFER_RECEIVE: 0,
  TRANSIT_WRITE_OFF: -1,
};

/**
 * Which way a transfer row moves stock at its side: a send takes units off
 * the source and puts them in transit; a receive takes them out of transit
 * onto the destination. Null for every other type (MOVEMENT_DIRECTION rules).
 */
function transferDirection(type: StockMovementType, inTransit: boolean): 1 | -1 | null {
  if (type === "TRANSFER_SEND") return inTransit ? 1 : -1;
  if (type === "TRANSFER_RECEIVE") return inTransit ? -1 : 1;
  return null;
}

const TRANSIT_TYPES: ReadonlySet<StockMovementType> = new Set(["TRANSFER_SEND", "TRANSFER_RECEIVE", "TRANSIT_WRITE_OFF"]);

export class StockMovementError extends Error {}

export type RecordStockMovementInput = {
  variantId: string;
  /** Where the units go in or out (lib/locations/service.ts); null = in transit (transfer rows only). */
  locationId: string | null;
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
  const inTransit = input.locationId === null;
  if (inTransit && !TRANSIT_TYPES.has(type)) throw new StockMovementError(`${type} needs a location — only a transfer is ever in transit`);
  if (!inTransit && type === "TRANSIT_WRITE_OFF") throw new StockMovementError("A transit write-off takes stock out of transit, not from a location");
  const direction = transferDirection(type, inTransit) ?? MOVEMENT_DIRECTION[type];
  if (direction !== 0 && Math.sign(qty) !== direction) {
    throw new StockMovementError(`${type} must move stock ${direction > 0 ? "in (positive qty)" : "out (negative qty)"}${TRANSIT_TYPES.has(type) ? (inTransit ? " in transit" : " at the location") : ""}`);
  }

  // The variant row first: it is the per-variant lock every stock writer
  // takes, so the location row below is only ever moved under it.
  const variant = await tx.productVariant.update({
    where: { id: variantId },
    data: {
      stockQty: { increment: qty },
      ...(inTransit ? { inTransitQty: { increment: qty } } : {}),
      ...(input.releaseReserved ? { reservedQty: { decrement: input.releaseReserved } } : {}),
    },
    select: { stockQty: true, inTransitQty: true },
  });
  const sideAfter = inTransit
    ? variant.inTransitQty
    : (
        await tx.variantStock.upsert({
          where: { variantId_locationId: { variantId, locationId: input.locationId! } },
          create: { variantId, locationId: input.locationId!, qty },
          update: { qty: { increment: qty } },
          select: { qty: true },
        })
      ).qty;

  return tx.stockMovement.create({
    data: {
      variantId,
      locationId: input.locationId,
      type,
      qty,
      stockAfter: variant.stockQty,
      locationStockAfter: sideAfter,
      unitCostSnapshot: new Prisma.Decimal(input.unitCost.toString()),
      referenceType: input.referenceType,
      referenceId: input.referenceId ?? null,
      actorId: input.actorId,
      note: input.note?.trim() || null,
    },
  });
}

export type LockedVariant = { id: string; stockQty: number; inTransitQty: number; reservedQty: number; weightedAvgCost: Prisma.Decimal };

/**
 * SELECT … FOR UPDATE on one variant. Anything that reads stock/WAC to
 * decide what to write (a purchase recomputing WAC, a write-off valuing
 * stock at cost, an adjustment refusing to go below zero) must take this
 * lock first so a concurrent change can't slip in between read and write.
 */
export async function lockVariant(tx: Prisma.TransactionClient, variantId: string): Promise<LockedVariant | null> {
  const rows = await tx.$queryRaw<LockedVariant[]>`
    SELECT "id", "stockQty", "inTransitQty", "reservedQty", "weightedAvgCost"
    FROM "product_variants"
    WHERE "id" = ${variantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type LockedVariantAt = LockedVariant & { locationId: string; locationQty: number };

/**
 * lockVariant plus that location's on-hand. Every stock writer updates the
 * variant row first (recordStockMovement), so holding its lock also holds
 * every location's figure for the variant still.
 */
export async function lockVariantAt(tx: Prisma.TransactionClient, variantId: string, locationId: string): Promise<LockedVariantAt | null> {
  const locked = await lockVariant(tx, variantId);
  if (!locked) return null;
  const row = await tx.variantStock.findUnique({ where: { variantId_locationId: { variantId, locationId } }, select: { qty: true } });
  return { ...locked, locationId, locationQty: row?.qty ?? 0 };
}

export type StockLedgerDivergence = {
  variantId: string;
  sku: string;
  /** Null for the variant's total, "In transit" for its in-transit figure, else the location that disagrees. */
  locationName: string | null;
  stockQty: number;
  ledgerQty: number;
};

/**
 * Every place stock ≠ sum(stock_movements.qty): a variant's total, its
 * in-transit figure (C4), or a (variant, location) pair — including a
 * location with ledger rows but no stock row, or the reverse. Should always be empty — the DB triggers make
 * it so.
 */
export async function findStockLedgerDivergences(client: Prisma.TransactionClient): Promise<StockLedgerDivergence[]> {
  const totals = await client.$queryRaw<{ variantId: string; sku: string; stockQty: number; ledgerQty: bigint }[]>`
    SELECT v."id" AS "variantId", v."sku", v."stockQty", COALESCE(SUM(m."qty"), 0) AS "ledgerQty"
    FROM "product_variants" v
    LEFT JOIN "stock_movements" m ON m."variantId" = v."id"
    GROUP BY v."id"
    HAVING v."stockQty" <> COALESCE(SUM(m."qty"), 0)
  `;
  const perLocation = await client.$queryRaw<{ variantId: string; sku: string; locationName: string; stockQty: number; ledgerQty: bigint }[]>`
    WITH ledger AS (
      SELECT "variantId", "locationId", SUM("qty") AS "qty" FROM "stock_movements" WHERE "locationId" IS NOT NULL GROUP BY "variantId", "locationId"
    )
    SELECT COALESCE(s."variantId", l."variantId") AS "variantId", v."sku", loc."name" AS "locationName",
           COALESCE(s."qty", 0) AS "stockQty", COALESCE(l."qty", 0) AS "ledgerQty"
    FROM "variant_stocks" s
    FULL OUTER JOIN ledger l ON l."variantId" = s."variantId" AND l."locationId" = s."locationId"
    JOIN "product_variants" v ON v."id" = COALESCE(s."variantId", l."variantId")
    JOIN "locations" loc ON loc."id" = COALESCE(s."locationId", l."locationId")
    WHERE COALESCE(s."qty", 0) <> COALESCE(l."qty", 0)
  `;
  const transit = await client.$queryRaw<{ variantId: string; sku: string; stockQty: number; ledgerQty: bigint }[]>`
    SELECT v."id" AS "variantId", v."sku", v."inTransitQty" AS "stockQty", COALESCE(SUM(m."qty"), 0) AS "ledgerQty"
    FROM "product_variants" v
    LEFT JOIN "stock_movements" m ON m."variantId" = v."id" AND m."locationId" IS NULL
    GROUP BY v."id"
    HAVING v."inTransitQty" <> COALESCE(SUM(m."qty"), 0)
  `;
  return [
    ...transit.map((r) => ({ ...r, locationName: "In transit", ledgerQty: Number(r.ledgerQty) })),
    ...totals.map((r) => ({ ...r, locationName: null, ledgerQty: Number(r.ledgerQty) })),
    ...perLocation.map((r) => ({ ...r, stockQty: Number(r.stockQty), ledgerQty: Number(r.ledgerQty) })),
  ];
}
