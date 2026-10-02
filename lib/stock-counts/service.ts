import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { adjustStock } from "@/lib/inventory/adjustments";
import { nextDocumentNumber } from "@/lib/inventory/document-number";
import { lockVariantAt } from "@/lib/inventory/ledger";
import { findVariantByScan, scannedItem, ScanError } from "@/lib/inventory/scan-lookup";
import { canActAt, getLocationAccess } from "@/lib/locations/service";
import { closeMisses } from "@/lib/shelves/engine";
import type { StockCountListItem, StockCountScopeValue, StockCountStatusValue, StockCountView } from "@/lib/stock-counts/constants";

// C4 — CORRECTIONS.md item 2, stock count by scan. A location's incharge
// (stock.count) opens a count and scans everything on the shelves; each
// scan adds one to that variant's counted figure. Posting — a
// Manager/Admin decision (inventory.adjust, the "Stock shortage" rules) —
// books every difference as a stock adjustment at that location, pointing
// back at the count, with its "Stock shortage" expense at cost.
//
// WHAT a line is compared with (PRD §4.3): a scan says what was on the
// shelf at the moment it was scanned, so each line is compared with the
// location's stock AT ITS LAST SCAN — read under the variant's lock and
// kept on the line (stockAtScan). That equals today's stock minus every
// movement the location's ledger made for the variant after the scan, so a
// POS sale or a transfer received between scanning and posting is never
// booked as found or short. Posting adds (counted − stock at scan) to
// today's stock.
//
//   SPOT count: only what was scanned is compared (a shelf, a rack).
//   FULL count: the whole location. An item it shows that nobody scanned
//               was not found and is taken off — but only if nothing moved
//               it at the location since the count opened (openedAtSeq).
//               If it was sold, received or transferred during the count,
//               nobody can tell whether the counter passed it before or
//               after, so it is left as it is and reported as "moved during
//               the count — scan it". Never a guessed expense.

export class StockCountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export { ScanError };

type CountRow = { id: string; countNo: string; status: StockCountStatusValue; locationId: string; scope: StockCountScopeValue; openedAtSeq: bigint };

async function lockCount(tx: Prisma.TransactionClient, id: string): Promise<CountRow> {
  const rows = await tx.$queryRaw<CountRow[]>`
    SELECT "id", "countNo", "status"::text AS "status", "locationId", "scope"::text AS "scope", "openedAtSeq"
    FROM "stock_counts" WHERE "id" = ${id} FOR UPDATE
  `;
  if (!rows[0]) throw new StockCountError("Stock count not found.", 404);
  return rows[0];
}

async function assertCounter(db: Db, user: SessionUser, locationId: string): Promise<void> {
  if (!(await can(user, "stock.count"))) throw new StockCountError("You can't count stock.", 403);
  if (!canActAt(await getLocationAccess(db, user), locationId)) {
    const name = (await db.location.findUnique({ where: { id: locationId }, select: { name: true } }))?.name ?? "that location";
    throw new StockCountError(`Only ${name}'s people can count it.`, 403);
  }
}

function requireOpen(c: CountRow): void {
  if (c.status !== "OPEN") throw new StockCountError(`${c.countNo} is ${c.status === "POSTED" ? "already posted" : "cancelled"}.`, 409);
}

export async function createStockCount(tx: Prisma.TransactionClient, user: SessionUser, input: { locationId: string; scope: StockCountScopeValue; note?: string | null }): Promise<{ id: string; countNo: string }> {
  await assertCounter(tx, user, input.locationId);
  const location = await tx.location.findUnique({ where: { id: input.locationId }, select: { isActive: true, name: true } });
  if (!location) throw new StockCountError("That location doesn't exist.");
  if (!location.isActive) throw new StockCountError(`${location.name} is switched off.`);
  const countNo = await nextDocumentNumber(tx, "SC");
  return tx.stockCount.create({
    data: { countNo, locationId: input.locationId, scope: input.scope, note: input.note?.trim() || null, createdById: user.id, openedAtSeq: await lastLedgerSeq(tx) },
    select: { id: true, countNo: true },
  });
}

/** The newest stock_movements.seq — everything up to it happened before now. */
async function lastLedgerSeq(tx: Prisma.TransactionClient): Promise<bigint> {
  const rows = await tx.$queryRaw<{ seq: bigint | null }[]>`SELECT MAX("seq") AS "seq" FROM "stock_movements"`;
  return rows[0]?.seq ?? BigInt(0);
}

/**
 * The location's stock for the variant right now, under the variant's lock
 * — every stock writer takes that lock first, so nothing can move it
 * between this read and the scan being saved.
 */
async function stockNowLocked(tx: Prisma.TransactionClient, variantId: string, locationId: string): Promise<number> {
  const locked = await lockVariantAt(tx, variantId, locationId);
  if (!locked) throw new StockCountError("That item doesn't exist.", 404);
  return locked.locationQty;
}

/** Of these variants, the ones whose stock at the location moved after ledger row `seq`. */
async function movedSince(db: Db, locationId: string, variantIds: string[], seq: bigint): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const rows = await db.stockMovement.findMany({ where: { locationId, variantId: { in: variantIds }, seq: { gt: seq } }, distinct: ["variantId"], select: { variantId: true } });
  return new Set(rows.map((r) => r.variantId));
}

export async function scanCountUnit(tx: Prisma.TransactionClient, user: SessionUser, countId: string, raw: string) {
  const c = await lockCount(tx, countId);
  requireOpen(c);
  await assertCounter(tx, user, c.locationId);
  const variant = await findVariantByScan(tx, raw);
  const stockAtScan = await stockNowLocked(tx, variant.id, c.locationId);
  const line = await tx.stockCountLine.upsert({
    where: { countId_variantId: { countId, variantId: variant.id } },
    create: { countId, variantId: variant.id, countedQty: 1, stockAtScan },
    update: { countedQty: { increment: 1 }, stockAtScan },
    select: { countedQty: true },
  });
  return { item: scannedItem(variant), count: line.countedQty, of: null, message: `${variant.sku} · ${line.countedQty} counted` };
}

export async function setCountLineQty(tx: Prisma.TransactionClient, user: SessionUser, countId: string, variantId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0) throw new StockCountError("Quantity must be a whole number, 0 or more.");
  const c = await lockCount(tx, countId);
  requireOpen(c);
  await assertCounter(tx, user, c.locationId);
  // A FULL count keeps a 0 line (counted: none); a SPOT count drops it (not counted).
  if (qty === 0 && c.scope === "SPOT") {
    await tx.stockCountLine.deleteMany({ where: { countId, variantId } });
    return;
  }
  // Typing a figure in is counting the shelf now — same as a scan.
  const stockAtScan = await stockNowLocked(tx, variantId, c.locationId);
  await tx.stockCountLine.upsert({ where: { countId_variantId: { countId, variantId } }, create: { countId, variantId, countedQty: qty, stockAtScan }, update: { countedQty: qty, stockAtScan } });
}

export async function cancelStockCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string): Promise<void> {
  const c = await lockCount(tx, countId);
  requireOpen(c);
  await assertCounter(tx, user, c.locationId);
  await tx.stockCount.update({ where: { id: countId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}

/**
 * Books the count. Each line is compared with the location's stock at its
 * last scan and the difference is added to today's stock — so it ends at
 * what was on the shelf at the scan plus everything that moved since. A
 * FULL count also takes off unscanned items that didn't move during it.
 */
export async function postStockCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string, meta: { request?: Request } = {}) {
  const c = await lockCount(tx, countId);
  requireOpen(c);
  if (!(await can(user, "inventory.adjust"))) throw new StockCountError("Posting a count changes stock — a Manager or Admin posts it.", 403);
  if (!canActAt(await getLocationAccess(tx, user), c.locationId)) throw new StockCountError("You don't act for that location.", 403);

  type Line = { id: string | null; variantId: string; countedQty: number; stockAtScan: number | null };
  const lines: Line[] = await tx.stockCountLine.findMany({ where: { countId }, select: { id: true, variantId: true, countedQty: true, stockAtScan: true } });
  if (c.scope === "FULL") {
    // Everything the location shows that nobody scanned: counted as none.
    const unscanned = await tx.variantStock.findMany({ where: { locationId: c.locationId, qty: { not: 0 }, variantId: { notIn: lines.map((l) => l.variantId) } }, select: { variantId: true } });
    for (const u of unscanned) lines.push({ id: null, variantId: u.variantId, countedQty: 0, stockAtScan: null });
  }
  if (lines.length === 0) throw new StockCountError("Nothing has been counted yet.");
  // One lock order (variant id) for every multi-variant stock writer.
  lines.sort((a, b) => a.variantId.localeCompare(b.variantId));

  const differences: { sku: string; expected: number; counted: number }[] = [];
  const movedDuringCount: string[] = [];
  let compared = 0;
  for (const line of lines) {
    const locked = await lockVariantAt(tx, line.variantId, c.locationId);
    if (!locked) throw new StockCountError("One of the counted items is no longer in the catalog.");
    let expected: number;
    if (line.id === null) {
      // Unscanned in a FULL count — taken off only if it sat still the whole count.
      if ((await movedSince(tx, c.locationId, [line.variantId], c.openedAtSeq)).size > 0) {
        movedDuringCount.push((await tx.productVariant.findUniqueOrThrow({ where: { id: line.variantId }, select: { sku: true } })).sku);
        continue;
      }
      expected = locked.locationQty;
      line.id = (await tx.stockCountLine.create({ data: { countId, variantId: line.variantId, countedQty: 0, stockAtScan: expected }, select: { id: true } })).id;
    } else {
      // A line scanned before stockAtScan existed: compared with now, as it was then.
      expected = line.stockAtScan ?? locked.locationQty;
    }
    compared++;
    await tx.stockCountLine.update({ where: { id: line.id }, data: { expectedQty: expected } });
    const diff = line.countedQty - expected;
    if (diff !== 0) {
      const { sku } = await tx.productVariant.findUniqueOrThrow({ where: { id: line.variantId }, select: { sku: true } });
      await adjustStock(tx, { variantId: line.variantId, locationId: c.locationId, qty: diff, reason: `Stock count ${c.countNo}: counted ${line.countedQty}, system showed ${expected} when scanned` }, user.id, {
        referenceType: "STOCK_COUNT",
        referenceId: countId,
      });
      differences.push({ sku, expected, counted: line.countedQty });
    }
    // C4b — the count has settled how many are in the building: units a
    // shelf count marked "not on its shelf" are either in that figure
    // (Unassigned, waiting to be put away) or were just taken off as short.
    await closeMisses(tx, { variantId: line.variantId, locationId: c.locationId, reason: "LOCATION_COUNT", actorId: user.id, note: `Stock count ${c.countNo}` });
  }

  await tx.stockCount.update({ where: { id: countId }, data: { status: "POSTED", postedById: user.id, postedAt: new Date() } });
  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "stock_count.post",
    entityType: "stock_count",
    entityId: countId,
    before: { status: "OPEN" },
    after: { status: "POSTED", countNo: c.countNo, scope: c.scope, itemsCompared: compared, differences, movedDuringCount },
    request: meta.request,
  });
  return { compared, differences: differences.length, movedDuringCount: movedDuringCount.length };
}

// ── Reading ─────────────────────────────────────────────────────────────

export async function getStockCountView(db: Db, user: SessionUser, countId: string): Promise<StockCountView | null> {
  const access = await getLocationAccess(db, user);
  const c = await db.stockCount.findFirst({
    where: { id: countId, ...(access.all ? {} : { locationId: { in: access.ids } }) },
    include: {
      location: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      postedBy: { select: { name: true } },
      lines: { select: { variantId: true, countedQty: true, stockAtScan: true, expectedQty: true } },
    },
  });
  if (!c) return null;

  // While open, a scanned line is compared with the stock at its last scan
  // (what posting will use); a FULL count's unscanned items with the stock
  // now — unless they moved during the count, which posting leaves alone.
  const open = c.status === "OPEN";
  const liveStock = open
    ? await db.variantStock.findMany({
        where: { locationId: c.locationId, ...(c.scope === "SPOT" ? { variantId: { in: c.lines.map((l) => l.variantId) } } : { OR: [{ qty: { not: 0 } }, { variantId: { in: c.lines.map((l) => l.variantId) } }] }) },
        select: { variantId: true, qty: true },
      })
    : [];
  const liveQty = new Map(liveStock.map((s) => [s.variantId, s.qty]));
  const counted = new Map(c.lines.map((l) => [l.variantId, l]));
  const moved =
    open && c.scope === "FULL"
      ? await movedSince(
          db,
          c.locationId,
          [...liveQty.keys()].filter((id) => !counted.has(id)),
          c.openedAtSeq,
        )
      : new Set<string>();
  const variantIds = [...new Set([...counted.keys(), ...liveQty.keys()])];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } }, product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } } },
  });

  const lines = variants
    .map((v) => {
      const line = counted.get(v.id);
      const countedQty = line?.countedQty ?? 0;
      const movedDuringCount = moved.has(v.id);
      const expected = open ? (line?.stockAtScan ?? liveQty.get(v.id) ?? 0) : (line?.expectedQty ?? 0);
      return {
        variantId: v.id,
        sku: v.sku,
        productName: v.product.name,
        sizeName: v.size.name,
        colorName: v.color.name,
        colorHex: v.color.hexCode,
        thumbPath: v.product.images[0]?.thumbPath ?? null,
        scanned: line !== undefined,
        movedDuringCount,
        counted: countedQty,
        expected,
        difference: movedDuringCount ? 0 : countedQty - expected,
      };
    })
    .filter((l) => !open || c.scope === "FULL" || l.scanned)
    .sort((a, b) => Number(a.difference === 0) - Number(b.difference === 0) || a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku));

  const [mayCount, mayPost] = await Promise.all([can(user, "stock.count"), can(user, "inventory.adjust")]);
  const atLocation = canActAt(access, c.locationId);
  return {
    id: c.id,
    countNo: c.countNo,
    status: c.status,
    scope: c.scope,
    location: c.location,
    note: c.note,
    createdByName: c.createdBy?.name ?? null,
    createdAt: c.createdAt.toISOString(),
    postedByName: c.postedBy?.name ?? null,
    postedAt: c.postedAt?.toISOString() ?? null,
    lines,
    totals: {
      counted: lines.reduce((a, l) => a + l.counted, 0),
      expected: lines.reduce((a, l) => a + l.expected, 0),
      short: lines.reduce((a, l) => a + Math.max(0, -l.difference), 0),
      extra: lines.reduce((a, l) => a + Math.max(0, l.difference), 0),
      itemsWithDifference: lines.filter((l) => l.difference !== 0).length,
    },
    can: { scan: open && mayCount && atLocation, post: open && mayPost && atLocation, cancel: open && mayCount && atLocation },
  };
}

export async function listStockCounts(
  db: Db,
  user: SessionUser,
  query: { status?: StockCountStatusValue; locationId?: string; from?: Date; to?: Date; page: number; pageSize: number },
): Promise<{ items: StockCountListItem[]; total: number }> {
  const access = await getLocationAccess(db, user);
  const where: Prisma.StockCountWhereInput = {
    AND: [
      access.all ? {} : { locationId: { in: access.ids } },
      query.locationId ? { locationId: query.locationId } : {},
      query.status ? { status: query.status } : {},
      // Open counts always show; finished ones by date.
      query.status !== "OPEN" && (query.from || query.to)
        ? { OR: [{ status: "OPEN" }, { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }] }
        : {},
    ],
  };
  const [rows, total] = await Promise.all([
    db.stockCount.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { location: { select: { name: true } }, createdBy: { select: { name: true } }, lines: { select: { countedQty: true, expectedQty: true } } },
    }),
    db.stockCount.count({ where }),
  ]);
  return {
    total,
    items: rows.map((c) => ({
      id: c.id,
      countNo: c.countNo,
      status: c.status,
      scope: c.scope,
      locationName: c.location.name,
      items: c.lines.length,
      units: c.lines.reduce((a, l) => a + l.countedQty, 0),
      differences: c.status === "POSTED" ? c.lines.filter((l) => l.expectedQty !== null && l.expectedQty !== l.countedQty).length : null,
      createdByName: c.createdBy?.name ?? null,
      createdAt: c.createdAt.toISOString(),
      postedAt: c.postedAt?.toISOString() ?? null,
    })),
  };
}
