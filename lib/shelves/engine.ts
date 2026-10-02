import type { Prisma, ShelfMovementKind } from "@prisma/client";

import { compareShelfCodes, type MissCloseReason } from "./constants";

// C4b — CORRECTIONS.md item 20A. The ONLY code that writes shelf_stocks,
// shelf_misses and shelf_movements. Shelves are a "where is it" layer
// inside a location: nothing here touches stock_movements, variant_stocks
// or money. For each (variant, location):
//
//   Unassigned        = location stock − sum(shelves)        (derived, never stored)
//   not on its shelf  = open shelf_misses — a labelled part of Unassigned
//
// The database refuses a commit where sum(shelves) + not-on-its-shelf
// exceeds the location's stock, or a shelf goes below zero (migration
// 20261006090000_shelves). Every function here runs under the variant's row
// lock (lockVariant — every stock writer takes it first), so the figures it
// reads can't move before it writes.
//
// Like lib/inventory/ledger.ts, free of "server-only" and of the prisma
// singleton: the ledger calls takeOffShelves, and prisma/seed.ts uses it.

type Tx = Prisma.TransactionClient;

export class ShelfError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type ShelfRow = { shelfId: string; code: string; qty: number };
type MissRow = { id: string; qty: number };

/** A variant's shelf layer at one location, read under the variant's lock. */
export type ShelfLayer = { stock: number; shelves: ShelfRow[]; misses: MissRow[]; shelved: number; missing: number };

export async function readShelfLayer(tx: Tx, variantId: string, locationId: string): Promise<ShelfLayer> {
  const [stockRow, shelves, misses] = await Promise.all([
    tx.variantStock.findUnique({ where: { variantId_locationId: { variantId, locationId } }, select: { qty: true } }),
    tx.shelfStock.findMany({ where: { variantId, locationId, qty: { gt: 0 } }, select: { shelfId: true, qty: true, shelf: { select: { code: true } } } }),
    tx.shelfMiss.findMany({ where: { variantId, locationId, closedAt: null }, select: { id: true, qty: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const rows = shelves.map((s) => ({ shelfId: s.shelfId, code: s.shelf.code, qty: s.qty }));
  return {
    stock: stockRow?.qty ?? 0,
    shelves: rows,
    misses,
    shelved: rows.reduce((a, s) => a + s.qty, 0),
    missing: misses.reduce((a, m) => a + m.qty, 0),
  };
}

/** Units in Unassigned that aren't "not on its shelf" — stock waiting to be put away. */
export function plainUnassigned(layer: ShelfLayer): number {
  return Math.max(0, Math.max(0, layer.stock) - layer.shelved - layer.missing);
}

/** The shelf holding the most of it first (ties: shelf code order). */
function largestFirst(shelves: ShelfRow[]): ShelfRow[] {
  return [...shelves].sort((a, b) => b.qty - a.qty || compareShelfCodes(a.code, b.code));
}

async function shiftShelf(tx: Tx, shelfId: string, locationId: string, variantId: string, delta: number): Promise<void> {
  const where = { shelfId_variantId: { shelfId, variantId } };
  if (delta > 0) {
    await tx.shelfStock.upsert({ where, create: { shelfId, locationId, variantId, qty: delta }, update: { qty: { increment: delta } } });
    return;
  }
  // The qty >= 0 CHECK refuses taking more than the shelf holds.
  const row = await tx.shelfStock.update({ where, data: { qty: { decrement: -delta } }, select: { qty: true } });
  if (row.qty === 0) await tx.shelfStock.delete({ where });
}

type Context = { variantId: string; locationId: string; actorId: string | null; note?: string | null; stockMovementId?: string | null; shelfCountId?: string | null };

async function logMove(tx: Tx, ctx: Context, kind: ShelfMovementKind, qty: number, sides: { fromShelfId?: string | null; toShelfId?: string | null; missId?: string | null }): Promise<void> {
  await tx.shelfMovement.create({
    data: {
      locationId: ctx.locationId,
      variantId: ctx.variantId,
      kind,
      qty,
      fromShelfId: sides.fromShelfId ?? null,
      toShelfId: sides.toShelfId ?? null,
      missId: sides.missId ?? null,
      stockMovementId: ctx.stockMovementId ?? null,
      shelfCountId: ctx.shelfCountId ?? null,
      actorId: ctx.actorId,
      note: ctx.note?.trim() || null,
    },
  });
}

/** Takes `qty` off one open miss, closing it when none are left. */
async function reduceMiss(tx: Tx, miss: MissRow, qty: number, reason: MissCloseReason, actorId: string | null): Promise<void> {
  const left = miss.qty - qty;
  await tx.shelfMiss.update({
    where: { id: miss.id },
    data: left > 0 ? { qty: left } : { qty: 0, closedAt: new Date(), closedById: actorId, closeReason: reason },
  });
  miss.qty = left;
}

export type ShelfPick = { shelfId: string; qty: number };

/**
 * Stock just LEFT the location (recordStockMovement, after its update):
 * `qty` units, leaving `stockAfter`. Item 20 / the owner's rule:
 *   1. units picked off a known shelf (a pick-list line, a scanned shelf)
 *      come off that shelf;
 *   2. the rest come out of Unassigned first — waiting-to-be-put-away
 *      units, then "not on its shelf" ones (a lost unit that turned up and
 *      left);
 *   3. then off the shelf holding the most of it.
 * Step 2 needs no write: Unassigned is whatever the shelves don't hold.
 */
export async function takeOffShelves(tx: Tx, input: Context & { qty: number; stockAfter: number; picks?: ShelfPick[] }): Promise<void> {
  const layer = await readShelfLayer(tx, input.variantId, input.locationId);
  if (layer.shelves.length === 0 && layer.misses.length === 0) return;

  let fromPicks = 0;
  for (const pick of input.picks ?? []) {
    const shelf = layer.shelves.find((s) => s.shelfId === pick.shelfId);
    const take = Math.min(pick.qty, input.qty - fromPicks, shelf?.qty ?? 0);
    if (!shelf || take <= 0) continue;
    await shiftShelf(tx, shelf.shelfId, input.locationId, input.variantId, -take);
    await logMove(tx, input, "OUT", take, { fromShelfId: shelf.shelfId });
    shelf.qty -= take;
    layer.shelved -= take;
    fromPicks += take;
  }

  let over = layer.shelved + layer.missing - Math.max(0, input.stockAfter);
  for (const miss of layer.misses) {
    if (over <= 0) return;
    const take = Math.min(over, miss.qty);
    await reduceMiss(tx, miss, take, "LEFT_LOCATION", input.actorId);
    await logMove(tx, input, "MISS_CLOSED", take, { missId: miss.id });
    over -= take;
  }
  for (const shelf of largestFirst(layer.shelves)) {
    if (over <= 0) return;
    const take = Math.min(over, shelf.qty);
    if (take <= 0) continue;
    await shiftShelf(tx, shelf.shelfId, input.locationId, input.variantId, -take);
    await logMove(tx, input, "OUT", take, { fromShelfId: shelf.shelfId });
    over -= take;
  }
}

export type PlaceResult = { placed: number; fromUnassigned: number; found: number; moved: { shelfId: string; code: string; qty: number }[]; unplaced: number };

/**
 * Puts `qty` units of a variant on `toShelfId`. From a named shelf (its
 * label was scanned first) — a move; otherwise from Unassigned first
 * (waiting units, then "not on its shelf" ones: found), then from the shelf
 * holding the most (a move). What can't be sourced comes back as
 * `unplaced` — more than the location has; the caller decides.
 */
export async function placeOnShelf(tx: Tx, input: Context & { toShelfId: string; qty: number; fromShelfId?: string | null }): Promise<PlaceResult> {
  const layer = await readShelfLayer(tx, input.variantId, input.locationId);
  const result: PlaceResult = { placed: 0, fromUnassigned: 0, found: 0, moved: [], unplaced: 0 };
  let left = input.qty;

  const moveFrom = async (shelf: ShelfRow, take: number) => {
    await shiftShelf(tx, shelf.shelfId, input.locationId, input.variantId, -take);
    await shiftShelf(tx, input.toShelfId, input.locationId, input.variantId, take);
    await logMove(tx, input, "MOVE", take, { fromShelfId: shelf.shelfId, toShelfId: input.toShelfId });
    shelf.qty -= take;
    result.moved.push({ shelfId: shelf.shelfId, code: shelf.code, qty: take });
    left -= take;
  };

  if (input.fromShelfId) {
    if (input.fromShelfId === input.toShelfId) throw new ShelfError("That's the shelf it is already on.");
    const shelf = layer.shelves.find((s) => s.shelfId === input.fromShelfId);
    const have = shelf?.qty ?? 0;
    if (have < left) throw new ShelfError(`The shelf you scanned first holds only ${have} of it.`, 409);
    await moveFrom(shelf!, left);
  } else {
    const waiting = Math.min(left, plainUnassigned(layer));
    if (waiting > 0) {
      await shiftShelf(tx, input.toShelfId, input.locationId, input.variantId, waiting);
      await logMove(tx, input, "PUT_AWAY", waiting, { toShelfId: input.toShelfId });
      result.fromUnassigned = waiting;
      left -= waiting;
    }
    for (const miss of layer.misses) {
      if (left <= 0) break;
      const take = Math.min(left, miss.qty);
      await reduceMiss(tx, miss, take, "FOUND", input.actorId);
      await shiftShelf(tx, input.toShelfId, input.locationId, input.variantId, take);
      await logMove(tx, input, "FOUND", take, { toShelfId: input.toShelfId, missId: miss.id });
      result.found += take;
      left -= take;
    }
    for (const shelf of largestFirst(layer.shelves.filter((s) => s.shelfId !== input.toShelfId))) {
      if (left <= 0) break;
      const take = Math.min(left, shelf.qty);
      if (take > 0) await moveFrom(shelf, take);
    }
  }
  result.unplaced = left;
  result.placed = input.qty - left;
  return result;
}

/** A shelf count didn't find `qty` units the shelf held: off the shelf, into "not on its shelf". */
export async function markMissingFromShelf(tx: Tx, input: Context & { shelfId: string; qty: number }): Promise<{ missId: string }> {
  await shiftShelf(tx, input.shelfId, input.locationId, input.variantId, -input.qty);
  const miss = await tx.shelfMiss.create({
    data: { locationId: input.locationId, variantId: input.variantId, shelfId: input.shelfId, shelfCountId: input.shelfCountId ?? null, qty: input.qty, originalQty: input.qty },
    select: { id: true },
  });
  await logMove(tx, input, "MISSING", input.qty, { fromShelfId: input.shelfId, missId: miss.id });
  return { missId: miss.id };
}

/** Closes open misses (oldest first, at most `qty`; all when omitted) without moving them anywhere. */
export async function closeMisses(tx: Tx, input: Context & { reason: MissCloseReason; qty?: number; missId?: string }): Promise<number> {
  const misses = await tx.shelfMiss.findMany({
    where: { variantId: input.variantId, locationId: input.locationId, closedAt: null, ...(input.missId ? { id: input.missId } : {}) },
    select: { id: true, qty: true },
    orderBy: { createdAt: "asc" },
  });
  let left = input.qty ?? Number.POSITIVE_INFINITY;
  let closed = 0;
  for (const miss of misses) {
    if (left <= 0) break;
    const take = Math.min(left, miss.qty);
    await reduceMiss(tx, miss, take, input.reason, input.actorId);
    await logMove(tx, input, "MISS_CLOSED", take, { missId: miss.id });
    left -= take;
    closed += take;
  }
  return closed;
}

/**
 * A location stops using shelves (Settings → Locations): every shelf figure
 * there is dropped — the units simply become the location's stock, with no
 * "where" — and units not on their shelf are closed. Stock doesn't move.
 */
/** What switching shelves off at a location would erase: every shelf placement there, and its open "not on its shelf" units. */
export type ShelfPlacementCount = { placements: number; shelvedUnits: number; shelves: number; notOnShelfUnits: number };

export async function countLocationShelfPlacements(client: Tx, locationId: string): Promise<ShelfPlacementCount> {
  const [placed, shelves, missing] = await Promise.all([
    client.shelfStock.aggregate({ where: { locationId, qty: { gt: 0 } }, _count: { _all: true }, _sum: { qty: true } }),
    client.shelfStock.groupBy({ by: ["shelfId"], where: { locationId, qty: { gt: 0 } } }),
    client.shelfMiss.aggregate({ where: { locationId, closedAt: null }, _sum: { qty: true } }),
  ]);
  return { placements: placed._count._all, shelvedUnits: placed._sum.qty ?? 0, shelves: shelves.length, notOnShelfUnits: missing._sum.qty ?? 0 };
}

export const sameShelfPlacementCount = (a: ShelfPlacementCount, b: ShelfPlacementCount) =>
  a.placements === b.placements && a.shelvedUnits === b.shelvedUnits && a.shelves === b.shelves && a.notOnShelfUnits === b.notOnShelfUnits;

export async function clearLocationShelves(tx: Tx, locationId: string, actorId: string | null): Promise<{ shelvedUnits: number; notOnShelfUnits: number }> {
  const shelved = await tx.shelfStock.aggregate({ where: { locationId }, _sum: { qty: true } });
  await tx.shelfStock.deleteMany({ where: { locationId } });
  const misses = await tx.shelfMiss.findMany({ where: { locationId, closedAt: null }, select: { id: true, qty: true, variantId: true } });
  for (const miss of misses) {
    await logMove(tx, { variantId: miss.variantId, locationId, actorId, note: "Shelves switched off at the location" }, "MISS_CLOSED", miss.qty, { missId: miss.id });
    await reduceMiss(tx, { id: miss.id, qty: miss.qty }, miss.qty, "SHELVES_OFF", actorId);
  }
  return { shelvedUnits: shelved._sum.qty ?? 0, notOnShelfUnits: misses.reduce((a, m) => a + m.qty, 0) };
}

/** The newest shelf_movements.seq — everything up to it happened before now. */
export async function lastShelfSeq(tx: Tx): Promise<bigint> {
  const rows = await tx.$queryRaw<{ seq: bigint | null }[]>`SELECT MAX("seq") AS "seq" FROM "shelf_movements"`;
  return rows[0]?.seq ?? BigInt(0);
}

/**
 * Every (variant, location) whose shelves + "not on its shelf" exceed its
 * stock, or a shelf below zero. Always empty — the DB triggers make it so.
 */
export async function findShelfDivergences(client: Tx): Promise<{ variantId: string; locationId: string; stock: number; shelved: number; missing: number }[]> {
  const rows = await client.$queryRaw<{ variantId: string; locationId: string; stock: number | null; shelved: bigint; missing: bigint; negative: bigint }[]>`
    WITH layer AS (
      SELECT "variantId", "locationId", SUM("qty") AS shelved, 0::bigint AS missing, COUNT(*) FILTER (WHERE "qty" < 0) AS negative FROM "shelf_stocks" GROUP BY 1, 2
      UNION ALL
      SELECT "variantId", "locationId", 0, SUM("qty"), 0 FROM "shelf_misses" WHERE "closedAt" IS NULL GROUP BY 1, 2
    )
    SELECT l."variantId", l."locationId", s."qty" AS stock, SUM(l.shelved)::bigint AS shelved, SUM(l.missing)::bigint AS missing, SUM(l.negative)::bigint AS negative
    FROM layer l
    LEFT JOIN "variant_stocks" s ON s."variantId" = l."variantId" AND s."locationId" = l."locationId"
    GROUP BY l."variantId", l."locationId", s."qty"
    HAVING SUM(l.shelved) + SUM(l.missing) > GREATEST(COALESCE(s."qty", 0), 0) OR SUM(l.negative) > 0
  `;
  return rows.map((r) => ({ variantId: r.variantId, locationId: r.locationId, stock: r.stock ?? 0, shelved: Number(r.shelved), missing: Number(r.missing) }));
}
