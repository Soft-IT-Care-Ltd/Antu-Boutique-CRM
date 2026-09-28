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
import type { StockCountListItem, StockCountScopeValue, StockCountStatusValue, StockCountView } from "@/lib/stock-counts/constants";

// C4 — CORRECTIONS.md item 2, stock count by scan. A location's incharge
// (stock.count) opens a count and scans everything on the shelves; each
// scan adds one to that variant's counted figure. The screen shows counted
// vs expected (the location's stock right now) per variant. Posting — a
// Manager/Admin decision (inventory.adjust, the "Stock shortage" rules) —
// books every difference as a stock adjustment at that location, pointing
// back at the count, with its "Stock shortage" expense at cost.
//
//   SPOT count: only what was scanned is compared (a shelf, a rack).
//   FULL count: the whole location — anything it shows that wasn't
//               scanned counts as 0 and is taken off.

export class StockCountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export { ScanError };

type CountRow = { id: string; countNo: string; status: StockCountStatusValue; locationId: string; scope: StockCountScopeValue };

async function lockCount(tx: Prisma.TransactionClient, id: string): Promise<CountRow> {
  const rows = await tx.$queryRaw<CountRow[]>`
    SELECT "id", "countNo", "status"::text AS "status", "locationId", "scope"::text AS "scope"
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
    data: { countNo, locationId: input.locationId, scope: input.scope, note: input.note?.trim() || null, createdById: user.id },
    select: { id: true, countNo: true },
  });
}

export async function scanCountUnit(tx: Prisma.TransactionClient, user: SessionUser, countId: string, raw: string) {
  const c = await lockCount(tx, countId);
  requireOpen(c);
  await assertCounter(tx, user, c.locationId);
  const variant = await findVariantByScan(tx, raw);
  const line = await tx.stockCountLine.upsert({
    where: { countId_variantId: { countId, variantId: variant.id } },
    create: { countId, variantId: variant.id, countedQty: 1 },
    update: { countedQty: { increment: 1 } },
    select: { countedQty: true },
  });
  return { item: scannedItem(variant), count: line.countedQty, of: null, message: `${variant.sku} · ${line.countedQty} counted` };
}

export async function setCountLineQty(tx: Prisma.TransactionClient, user: SessionUser, countId: string, variantId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0) throw new StockCountError("Quantity must be a whole number, 0 or more.");
  const c = await lockCount(tx, countId);
  requireOpen(c);
  await assertCounter(tx, user, c.locationId);
  const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { id: true } });
  if (!variant) throw new StockCountError("That item doesn't exist.", 404);
  // A FULL count keeps a 0 line (counted: none); a SPOT count drops it (not counted).
  if (qty === 0 && c.scope === "SPOT") {
    await tx.stockCountLine.deleteMany({ where: { countId, variantId } });
    return;
  }
  await tx.stockCountLine.upsert({ where: { countId_variantId: { countId, variantId } }, create: { countId, variantId, countedQty: qty }, update: { countedQty: qty } });
}

export async function cancelStockCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string): Promise<void> {
  const c = await lockCount(tx, countId);
  requireOpen(c);
  await assertCounter(tx, user, c.locationId);
  await tx.stockCount.update({ where: { id: countId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}

/**
 * Books the count: for every variant compared, locks it, reads the
 * location's stock NOW (what moved during the count is already in it) and
 * posts counted − expected as an adjustment (+ found / − short).
 */
export async function postStockCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string, meta: { request?: Request } = {}) {
  const c = await lockCount(tx, countId);
  requireOpen(c);
  if (!(await can(user, "inventory.adjust"))) throw new StockCountError("Posting a count changes stock — a Manager or Admin posts it.", 403);
  if (!canActAt(await getLocationAccess(tx, user), c.locationId)) throw new StockCountError("You don't act for that location.", 403);

  const lines = await tx.stockCountLine.findMany({ where: { countId }, select: { id: true, variantId: true, countedQty: true } });
  if (c.scope === "FULL") {
    // Everything the location shows that nobody scanned was counted as none.
    const unscanned = await tx.variantStock.findMany({ where: { locationId: c.locationId, qty: { not: 0 }, variantId: { notIn: lines.map((l) => l.variantId) } }, select: { variantId: true } });
    for (const u of unscanned) lines.push(await tx.stockCountLine.create({ data: { countId, variantId: u.variantId, countedQty: 0 }, select: { id: true, variantId: true, countedQty: true } }));
  }
  if (lines.length === 0) throw new StockCountError("Nothing has been counted yet.");
  lines.sort((a, b) => a.variantId.localeCompare(b.variantId));

  const differences: { sku: string; expected: number; counted: number }[] = [];
  for (const line of lines) {
    const locked = await lockVariantAt(tx, line.variantId, c.locationId);
    if (!locked) throw new StockCountError("One of the counted items is no longer in the catalog.");
    const expected = locked.locationQty;
    await tx.stockCountLine.update({ where: { id: line.id }, data: { expectedQty: expected } });
    const diff = line.countedQty - expected;
    if (diff === 0) continue;
    const { sku } = await tx.productVariant.findUniqueOrThrow({ where: { id: line.variantId }, select: { sku: true } });
    await adjustStock(tx, { variantId: line.variantId, locationId: c.locationId, qty: diff, reason: `Stock count ${c.countNo}: counted ${line.countedQty}, system showed ${expected}` }, user.id, {
      referenceType: "STOCK_COUNT",
      referenceId: countId,
    });
    differences.push({ sku, expected, counted: line.countedQty });
  }

  await tx.stockCount.update({ where: { id: countId }, data: { status: "POSTED", postedById: user.id, postedAt: new Date() } });
  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "stock_count.post",
    entityType: "stock_count",
    entityId: countId,
    before: { status: "OPEN" },
    after: { status: "POSTED", countNo: c.countNo, scope: c.scope, itemsCompared: lines.length, differences },
    request: meta.request,
  });
  return { compared: lines.length, differences: differences.length };
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
      lines: { select: { variantId: true, countedQty: true, expectedQty: true } },
    },
  });
  if (!c) return null;

  // While open, "expected" is the location's stock right now; for a FULL
  // count that includes everything there that hasn't been scanned yet.
  const open = c.status === "OPEN";
  const liveStock = open
    ? await db.variantStock.findMany({
        where: { locationId: c.locationId, ...(c.scope === "SPOT" ? { variantId: { in: c.lines.map((l) => l.variantId) } } : { OR: [{ qty: { not: 0 } }, { variantId: { in: c.lines.map((l) => l.variantId) } }] }) },
        select: { variantId: true, qty: true },
      })
    : [];
  const liveQty = new Map(liveStock.map((s) => [s.variantId, s.qty]));
  const counted = new Map(c.lines.map((l) => [l.variantId, l]));
  const variantIds = [...new Set([...counted.keys(), ...liveQty.keys()])];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } }, product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } } },
  });

  const lines = variants
    .map((v) => {
      const line = counted.get(v.id);
      const countedQty = line?.countedQty ?? 0;
      const expected = open ? (liveQty.get(v.id) ?? 0) : (line?.expectedQty ?? 0);
      return {
        variantId: v.id,
        sku: v.sku,
        productName: v.product.name,
        sizeName: v.size.name,
        colorName: v.color.name,
        colorHex: v.color.hexCode,
        thumbPath: v.product.images[0]?.thumbPath ?? null,
        scanned: line !== undefined,
        counted: countedQty,
        expected,
        difference: countedQty - expected,
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
