import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { can } from "@/lib/auth/permissions";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { adjustStock } from "@/lib/inventory/adjustments";
import { lockVariant } from "@/lib/inventory/ledger";
import { findVariantByScan, scannedItem, scannedVariantSelect, ScanError } from "@/lib/inventory/scan-lookup";
import { canActAt, getLocationAccess } from "@/lib/locations/service";
import {
  compareShelfCodes,
  normalizeShelfCode,
  SHELF_CODE_MESSAGE,
  type ShelfContentLine,
  type ShelfCountView,
  type ShelfLocationView,
  type ShelfMissView,
  type ShelfWhereabouts,
  type UnassignedLine,
} from "@/lib/shelves/constants";
import { closeMisses, lastShelfSeq, markMissingFromShelf, placeOnShelf, readShelfLayer, ShelfError, type PlaceResult } from "@/lib/shelves/engine";
import { findShelfByScan } from "@/lib/shelves/scan";

// C4b — CORRECTIONS.md item 20A: shelves inside a location. Who may do
// what, the screens' data, and the flows on top of lib/shelves/engine.ts:
//
//   - Settings: a location "uses shelves" (Settings → Locations). One that
//     doesn't (the Shyamoli showroom) has no shelf screens and no Unassigned.
//   - shelf.manage (Admin, Manager): create shelves, print their labels.
//   - shelf.putaway (+ the location): put away — scan dresses, then the
//     shelf; moving — scan the shelf they're on first, or let the system
//     take them from where they are (Unassigned first).
//   - stock.count (+ the location): count one shelf. Finishing moves units
//     between the shelf and Unassigned / "not on its shelf"; it never
//     changes stock. Missing units are a manager's to write off
//     (inventory.adjust — the Stock shortage expense) or a location count's
//     to settle.

export { ShelfError, ScanError };

async function assertShelfLocation(db: Db, locationId: string): Promise<{ id: string; name: string }> {
  const location = await db.location.findUnique({ where: { id: locationId }, select: { id: true, name: true, isActive: true, usesShelves: true } });
  if (!location) throw new ShelfError("That location doesn't exist.", 404);
  if (!location.isActive) throw new ShelfError(`${location.name} is switched off.`, 409);
  if (!location.usesShelves) throw new ShelfError(`${location.name} doesn't use shelves — switch it on in Settings → Locations.`, 409);
  return { id: location.id, name: location.name };
}

async function assertActs(db: Db, user: SessionUser, permission: PermissionKey, locationId: string, what: string): Promise<{ id: string; name: string }> {
  if (!(await can(user, permission))) throw new ShelfError(`You can't ${what}.`, 403);
  const location = await assertShelfLocation(db, locationId);
  if (!canActAt(await getLocationAccess(db, user), locationId)) throw new ShelfError(`Only ${location.name}'s people can ${what}.`, 403);
  return location;
}

// ── Shelves ─────────────────────────────────────────────────────────────

export async function createShelves(tx: Prisma.TransactionClient, user: SessionUser, input: { locationId: string; codes: string[]; note?: string | null }, meta: { request?: Request } = {}) {
  const location = await assertActs(tx, user, "shelf.manage", input.locationId, "add shelves there");
  const codes: string[] = [];
  for (const raw of input.codes) {
    const code = normalizeShelfCode(raw);
    if (!code) throw new ShelfError(`“${raw.trim().slice(0, 20)}”: ${SHELF_CODE_MESSAGE}.`);
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) throw new ShelfError("Give at least one shelf code.");
  const existing = await tx.shelf.findMany({ where: { locationId: input.locationId, code: { in: codes } }, select: { code: true } });
  if (existing.length > 0) throw new ShelfError(`${location.name} already has ${existing.map((e) => e.code).sort(compareShelfCodes).join(", ")}.`, 409);
  await tx.shelf.createMany({ data: codes.map((code) => ({ locationId: input.locationId, code, note: input.note?.trim() || null })) });
  await writeAuditLogWith(tx, { actorId: user.id, action: "shelf.create", entityType: "location", entityId: input.locationId, after: { location: location.name, codes }, request: meta.request });
  return { created: codes.length };
}

export async function updateShelf(tx: Prisma.TransactionClient, user: SessionUser, shelfId: string, input: { note?: string | null; isActive?: boolean }, meta: { request?: Request } = {}) {
  const shelf = await tx.shelf.findUnique({ where: { id: shelfId }, select: { id: true, code: true, note: true, isActive: true, locationId: true } });
  if (!shelf) throw new ShelfError("Shelf not found.", 404);
  await assertActs(tx, user, "shelf.manage", shelf.locationId, "change shelves there");
  if (input.isActive === false && shelf.isActive) {
    const [held, missing] = await Promise.all([tx.shelfStock.count({ where: { shelfId, qty: { gt: 0 } } }), tx.shelfMiss.count({ where: { shelfId, closedAt: null } })]);
    if (held > 0) throw new ShelfError(`${shelf.code} still holds stock — move it to another shelf first.`, 409);
    if (missing > 0) throw new ShelfError(`${shelf.code} has units not on their shelf waiting for a manager — settle them first.`, 409);
  }
  const data = { ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) };
  await tx.shelf.update({ where: { id: shelfId }, data });
  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "shelf.update",
    entityType: "shelf",
    entityId: shelfId,
    before: { code: shelf.code, note: shelf.note, isActive: shelf.isActive },
    after: { code: shelf.code, note: data.note ?? shelf.note, isActive: data.isActive ?? shelf.isActive },
    request: meta.request,
  });
}

/** The active shelf-using locations, with whether this person acts for each. */
export async function listShelfLocations(db: Db, user: SessionUser): Promise<{ id: string; name: string; mine: boolean }[]> {
  const [locations, access] = await Promise.all([
    db.location.findMany({ where: { isActive: true, usesShelves: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    getLocationAccess(db, user),
  ]);
  return locations.map((l) => ({ ...l, mine: canActAt(access, l.id) }));
}

type VariantInfo = Prisma.ProductVariantGetPayload<{ select: typeof scannedVariantSelect }>;

async function variantInfo(db: Db, ids: string[]): Promise<Map<string, Omit<ShelfContentLine, "qty">>> {
  if (ids.length === 0) return new Map();
  const rows: VariantInfo[] = await db.productVariant.findMany({ where: { id: { in: ids } }, select: scannedVariantSelect });
  return new Map(rows.map((v) => [v.id, scannedItem(v)]));
}

const byName = (a: { productName: string; sku: string }, b: { productName: string; sku: string }) => a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku);

/** Shelves page: every shelf, what's waiting to be put away, and what's not on its shelf. */
export async function getShelfLocationView(db: Db, user: SessionUser, locationId: string): Promise<ShelfLocationView> {
  const location = await assertShelfLocation(db, locationId);
  const [shelves, perShelf, openCounts, stocks, shelvedByVariant, misses, access, mayManage, mayPutAway, mayCount, mayAdjust] = await Promise.all([
    db.shelf.findMany({ where: { locationId }, select: { id: true, code: true, note: true, isActive: true, lastCountedAt: true } }),
    db.shelfStock.groupBy({ by: ["shelfId"], where: { locationId, qty: { gt: 0 } }, _sum: { qty: true }, _count: { _all: true } }),
    db.shelfCount.findMany({ where: { locationId, status: "OPEN" }, select: { id: true, shelfId: true } }),
    db.variantStock.findMany({ where: { locationId, qty: { gt: 0 } }, select: { variantId: true, qty: true } }),
    db.shelfStock.groupBy({ by: ["variantId"], where: { locationId }, _sum: { qty: true } }),
    db.shelfMiss.findMany({ where: { locationId, closedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, variantId: true, qty: true, createdAt: true, shelf: { select: { code: true } } } }),
    getLocationAccess(db, user),
    can(user, "shelf.manage"),
    can(user, "shelf.putaway"),
    can(user, "stock.count"),
    can(user, "inventory.adjust"),
  ]);
  const held = new Map(perShelf.map((p) => [p.shelfId, { units: p._sum.qty ?? 0, items: p._count._all }]));
  const counting = new Map(openCounts.map((c) => [c.shelfId, c.id]));
  const shelvedQty = new Map(shelvedByVariant.map((s) => [s.variantId, s._sum.qty ?? 0]));
  const missingQty = new Map<string, number>();
  for (const m of misses) missingQty.set(m.variantId, (missingQty.get(m.variantId) ?? 0) + m.qty);

  const unassignedRows = stocks.map((s) => ({ variantId: s.variantId, qty: s.qty - (shelvedQty.get(s.variantId) ?? 0) })).filter((r) => r.qty > 0);
  const info = await variantInfo(db, [...new Set([...unassignedRows.map((r) => r.variantId), ...misses.map((m) => m.variantId)])]);
  const unassigned: UnassignedLine[] = unassignedRows
    .flatMap((r) => {
      const item = info.get(r.variantId);
      return item ? [{ ...item, qty: r.qty, notOnShelf: missingQty.get(r.variantId) ?? 0 }] : [];
    })
    .sort((a, b) => b.qty - b.notOnShelf - (a.qty - a.notOnShelf) || byName(a, b));
  const missViews: ShelfMissView[] = misses.flatMap((m) => {
    const item = info.get(m.variantId);
    return item ? [{ id: m.id, shelfCode: m.shelf.code, qty: m.qty, createdAt: m.createdAt.toISOString(), item }] : [];
  });

  const stockTotal = stocks.reduce((a, s) => a + s.qty, 0);
  const shelvedTotal = perShelf.reduce((a, p) => a + (p._sum.qty ?? 0), 0);
  const atLocation = canActAt(access, locationId);
  return {
    location,
    shelves: shelves
      .map((s) => ({
        id: s.id,
        code: s.code,
        note: s.note,
        isActive: s.isActive,
        units: held.get(s.id)?.units ?? 0,
        items: held.get(s.id)?.items ?? 0,
        lastCountedAt: s.lastCountedAt?.toISOString() ?? null,
        openCountId: counting.get(s.id) ?? null,
      }))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || compareShelfCodes(a.code, b.code)),
    totals: { stock: stockTotal, shelved: shelvedTotal, unassigned: unassignedRows.reduce((a, r) => a + r.qty, 0), notOnShelf: misses.reduce((a, m) => a + m.qty, 0) },
    unassigned,
    misses: missViews,
    can: { manage: mayManage && atLocation, putAway: mayPutAway && atLocation, count: mayCount && atLocation, writeOff: mayAdjust && atLocation },
  };
}

export async function getShelfView(db: Db, user: SessionUser, shelfId: string) {
  const shelf = await db.shelf.findUnique({ where: { id: shelfId }, select: { id: true, code: true, note: true, isActive: true, lastCountedAt: true, locationId: true, location: { select: { name: true } } } });
  if (!shelf) return null;
  const [stocks, openCount, moves, access, mayCount, mayManage] = await Promise.all([
    db.shelfStock.findMany({ where: { shelfId, qty: { gt: 0 } }, select: { variantId: true, qty: true } }),
    db.shelfCount.findFirst({ where: { shelfId, status: "OPEN" }, select: { id: true } }),
    db.shelfMovement.findMany({
      where: { OR: [{ fromShelfId: shelfId }, { toShelfId: shelfId }] },
      orderBy: { seq: "desc" },
      take: 20,
      select: { id: true, kind: true, qty: true, fromShelfId: true, createdAt: true, fromShelf: { select: { code: true } }, toShelf: { select: { code: true } }, actor: { select: { name: true } }, variantId: true },
    }),
    getLocationAccess(db, user),
    can(user, "stock.count"),
    can(user, "shelf.manage"),
  ]);
  const info = await variantInfo(db, [...new Set([...stocks.map((s) => s.variantId), ...moves.map((m) => m.variantId)])]);
  const contents = stocks.flatMap((s) => {
    const item = info.get(s.variantId);
    return item ? [{ ...item, qty: s.qty }] : [];
  });
  contents.sort(byName);
  const atLocation = canActAt(access, shelf.locationId);
  return {
    id: shelf.id,
    code: shelf.code,
    note: shelf.note,
    isActive: shelf.isActive,
    lastCountedAt: shelf.lastCountedAt?.toISOString() ?? null,
    location: { id: shelf.locationId, name: shelf.location.name },
    contents,
    units: contents.reduce((a, c) => a + c.qty, 0),
    openCountId: openCount?.id ?? null,
    history: moves.map((m) => ({
      id: m.id,
      kind: m.kind,
      qty: m.qty,
      // Seen from this shelf: units in or out.
      direction: m.fromShelfId === shelfId ? ("out" as const) : ("in" as const),
      otherShelf: m.fromShelfId === shelfId ? (m.toShelf?.code ?? null) : (m.fromShelf?.code ?? null),
      sku: info.get(m.variantId)?.sku ?? "",
      productName: info.get(m.variantId)?.productName ?? "",
      actorName: m.actor?.name ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
    can: { count: mayCount && atLocation && shelf.isActive, manage: mayManage && atLocation },
  };
}

// ── Where is it (stock lookup, order screen, packing) ───────────────────

/** For each variant: its shelves, Unassigned and not-on-its-shelf at every shelf-using location (or only `locationIds`). */
export async function shelfWhereabouts(db: Db, variantIds: string[], locationIds?: string[]): Promise<Map<string, ShelfWhereabouts[]>> {
  const out = new Map<string, ShelfWhereabouts[]>();
  if (variantIds.length === 0) return out;
  const locations = await db.location.findMany({ where: { usesShelves: true, ...(locationIds ? { id: { in: locationIds } } : {}) }, select: { id: true } });
  if (locations.length === 0) return out;
  const locIds = locations.map((l) => l.id);
  const [stocks, shelfRows, misses] = await Promise.all([
    db.variantStock.findMany({ where: { variantId: { in: variantIds }, locationId: { in: locIds } }, select: { variantId: true, locationId: true, qty: true } }),
    db.shelfStock.findMany({ where: { variantId: { in: variantIds }, locationId: { in: locIds }, qty: { gt: 0 } }, select: { variantId: true, locationId: true, shelfId: true, qty: true, shelf: { select: { code: true } } } }),
    db.shelfMiss.groupBy({ by: ["variantId", "locationId"], where: { variantId: { in: variantIds }, locationId: { in: locIds }, closedAt: null }, _sum: { qty: true } }),
  ]);
  const key = (v: string, l: string) => `${v}|${l}`;
  const missing = new Map(misses.map((m) => [key(m.variantId, m.locationId), m._sum.qty ?? 0]));
  for (const s of stocks) {
    const shelves = shelfRows
      .filter((r) => r.variantId === s.variantId && r.locationId === s.locationId)
      .map((r) => ({ shelfId: r.shelfId, code: r.shelf.code, qty: r.qty }))
      .sort((a, b) => b.qty - a.qty || compareShelfCodes(a.code, b.code));
    const shelved = shelves.reduce((a, r) => a + r.qty, 0);
    if (s.qty <= 0 && shelved === 0) continue;
    const list = out.get(s.variantId) ?? [];
    list.push({ locationId: s.locationId, shelves, unassigned: Math.max(0, s.qty) - shelved, notOnShelf: missing.get(key(s.variantId, s.locationId)) ?? 0 });
    out.set(s.variantId, list);
  }
  return out;
}

// ── Put away / move ─────────────────────────────────────────────────────

export type IdentifyResult =
  | { kind: "shelf"; shelf: { id: string; code: string }; message: string }
  | { kind: "item"; item: ReturnType<typeof scannedItem>; where: { unassigned: number; notOnShelf: number; shelves: { shelfId: string; code: string; qty: number }[] }; message: string };

/** One scan on the put-away screen: a shelf label, or a dress (with where it is now). Changes nothing. */
export async function identifyPutAwayScan(db: Db, user: SessionUser, locationId: string, raw: string): Promise<IdentifyResult> {
  await assertActs(db, user, "shelf.putaway", locationId, "put stock away there");
  const shelf = await findShelfByScan(db, raw, locationId);
  if (shelf) return { kind: "shelf", shelf, message: `Shelf ${shelf.code}` };
  const variant = await findVariantByScan(db, raw);
  const where = (await shelfWhereabouts(db, [variant.id], [locationId])).get(variant.id)?.[0];
  if (!where) throw new ScanError(`${variant.sku}: the system shows none here. Count it first if the dress is really here.`, 409);
  return { kind: "item", item: scannedItem(variant), where: { unassigned: where.unassigned, notOnShelf: where.notOnShelf, shelves: where.shelves }, message: `${variant.sku} · ${variant.product.name}` };
}

export type PutAwayInput = { locationId: string; toShelfId: string; fromShelfId?: string | null; items: { variantId: string; qty: number }[] };

/**
 * The scanned dresses go on the scanned shelf, all or nothing. From the
 * shelf scanned first (a move), else from Unassigned first, then from the
 * shelf holding the most.
 */
export async function putAway(tx: Prisma.TransactionClient, user: SessionUser, input: PutAwayInput): Promise<{ shelfCode: string; results: (PlaceResult & { sku: string })[] }> {
  await assertActs(tx, user, "shelf.putaway", input.locationId, "put stock away there");
  const [to, from] = await Promise.all([
    tx.shelf.findFirst({ where: { id: input.toShelfId, locationId: input.locationId }, select: { id: true, code: true, isActive: true } }),
    input.fromShelfId ? tx.shelf.findFirst({ where: { id: input.fromShelfId, locationId: input.locationId }, select: { id: true, code: true } }) : null,
  ]);
  if (!to) throw new ShelfError("That shelf isn't at this location.", 404);
  if (!to.isActive) throw new ShelfError(`Shelf ${to.code} is switched off.`, 409);
  if (input.fromShelfId && !from) throw new ShelfError("The shelf scanned first isn't at this location.", 404);

  const qtyBy = new Map<string, number>();
  for (const i of input.items) qtyBy.set(i.variantId, (qtyBy.get(i.variantId) ?? 0) + i.qty);
  if (qtyBy.size === 0) throw new ShelfError("Scan the dresses first, then the shelf.");
  const results: (PlaceResult & { sku: string })[] = [];
  // One lock order (variant id) for every multi-variant stock writer.
  for (const variantId of [...qtyBy.keys()].sort()) {
    const locked = await lockVariant(tx, variantId);
    if (!locked) throw new ShelfError("One of the items is no longer in the catalog.", 404);
    const { sku } = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { sku: true } });
    const qty = qtyBy.get(variantId)!;
    // Refuse before writing anything: everything not already on the target shelf can be brought to it.
    const layer = await readShelfLayer(tx, variantId, input.locationId);
    const onTarget = layer.shelves.find((s) => s.shelfId === to.id)?.qty ?? 0;
    if (!from && qty > Math.max(0, layer.stock) - onTarget) {
      throw new ShelfError(`${sku}: the system shows ${Math.max(0, layer.stock)} here${onTarget ? `, ${onTarget} already on ${to.code}` : ""} — can't put ${qty} more on it. Count it first if the dress is really here.`, 409);
    }
    const result = await placeOnShelf(tx, { variantId, locationId: input.locationId, toShelfId: to.id, qty, fromShelfId: from?.id ?? null, actorId: user.id });
    results.push({ ...result, sku });
  }
  return { shelfCode: to.code, results };
}

// ── Not on its shelf ────────────────────────────────────────────────────

/** A manager writes off units not found on their shelf: they leave the location's stock as a Stock shortage. */
export async function writeOffMiss(tx: Prisma.TransactionClient, user: SessionUser, missId: string, reason: string, meta: { request?: Request } = {}) {
  const miss = await tx.shelfMiss.findUnique({ where: { id: missId }, select: { id: true, variantId: true, locationId: true, closedAt: true, shelf: { select: { code: true } } } });
  if (!miss) throw new ShelfError("Not found.", 404);
  if (!(await can(user, "inventory.adjust"))) throw new ShelfError("Writing off stock is a Manager's or Admin's decision.", 403);
  if (!canActAt(await getLocationAccess(tx, user), miss.locationId)) throw new ShelfError("You don't act for that location.", 403);
  if (!reason.trim()) throw new ShelfError("Say why it's written off.");
  await lockVariant(tx, miss.variantId);
  // Re-read under the lock: a sale may have just used some of it up.
  const fresh = await tx.shelfMiss.findUniqueOrThrow({ where: { id: missId }, select: { qty: true, closedAt: true } });
  if (fresh.closedAt || fresh.qty === 0) throw new ShelfError("It has already been settled.", 409);
  const qty = fresh.qty;
  // Close the miss first, so the stock leaving is exactly these units.
  await closeMisses(tx, { variantId: miss.variantId, locationId: miss.locationId, missId, reason: "WRITTEN_OFF", actorId: user.id, note: reason });
  const { movement, expense } = await adjustStock(tx, { variantId: miss.variantId, locationId: miss.locationId, qty: -qty, reason: `Not on its shelf (${miss.shelf.code}) — ${reason.trim()}` }, user.id, { referenceType: "ADJUSTMENT", referenceId: missId });
  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "shelf_miss.write_off",
    entityType: "shelf_miss",
    entityId: missId,
    before: { qty, shelf: miss.shelf.code },
    after: { qty: 0, writtenOff: qty, reason: reason.trim(), stockMovementId: movement.id, expenseId: expense?.id ?? null },
    request: meta.request,
  });
  return { qty };
}

// ── Counting one shelf ──────────────────────────────────────────────────

type CountRow = { id: string; status: "OPEN" | "DONE" | "CANCELLED"; shelfId: string; locationId: string; openedAtSeq: bigint };

async function lockShelfCount(tx: Prisma.TransactionClient, id: string): Promise<CountRow> {
  const rows = await tx.$queryRaw<CountRow[]>`
    SELECT "id", "status"::text AS "status", "shelfId", "locationId", "openedAtSeq" FROM "shelf_counts" WHERE "id" = ${id} FOR UPDATE
  `;
  if (!rows[0]) throw new ShelfError("Shelf count not found.", 404);
  return rows[0];
}

function requireOpen(c: CountRow): void {
  if (c.status !== "OPEN") throw new ShelfError(`This shelf count is ${c.status === "DONE" ? "already finished" : "cancelled"}.`, 409);
}

/** Opens a count of one shelf — or returns the one already open on it. */
export async function startShelfCount(tx: Prisma.TransactionClient, user: SessionUser, shelfId: string): Promise<{ id: string }> {
  // Lock the shelf: two people starting at once get the same count.
  const rows = await tx.$queryRaw<{ id: string; locationId: string; code: string; isActive: boolean }[]>`SELECT "id", "locationId", "code", "isActive" FROM "shelves" WHERE "id" = ${shelfId} FOR UPDATE`;
  const shelf = rows[0];
  if (!shelf) throw new ShelfError("Shelf not found.", 404);
  await assertActs(tx, user, "stock.count", shelf.locationId, "count shelves there");
  if (!shelf.isActive) throw new ShelfError(`Shelf ${shelf.code} is switched off.`, 409);
  const open = await tx.shelfCount.findFirst({ where: { shelfId, status: "OPEN" }, select: { id: true } });
  if (open) return open;
  return tx.shelfCount.create({ data: { shelfId, locationId: shelf.locationId, createdById: user.id, openedAtSeq: await lastShelfSeq(tx) }, select: { id: true } });
}

/** The shelf's figure for a variant right now, under the variant's lock. */
async function shelfQtyLocked(tx: Prisma.TransactionClient, shelfId: string, variantId: string): Promise<number> {
  if (!(await lockVariant(tx, variantId))) throw new ShelfError("That item doesn't exist.", 404);
  return (await tx.shelfStock.findUnique({ where: { shelfId_variantId: { shelfId, variantId } }, select: { qty: true } }))?.qty ?? 0;
}

export async function scanShelfCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string, raw: string): Promise<{ message: string }> {
  const c = await lockShelfCount(tx, countId);
  requireOpen(c);
  await assertActs(tx, user, "stock.count", c.locationId, "count shelves there");
  const shelf = await findShelfByScan(tx, raw, c.locationId);
  if (shelf) {
    if (shelf.id === c.shelfId) return { message: `Shelf ${shelf.code} — scan everything on it` };
    const mine = await tx.shelf.findUniqueOrThrow({ where: { id: c.shelfId }, select: { code: true } });
    throw new ScanError(`That's shelf ${shelf.code} — this count is for ${mine.code}. Finish it first.`, 409);
  }
  const variant = await findVariantByScan(tx, raw);
  const shelfQtyAtScan = await shelfQtyLocked(tx, c.shelfId, variant.id);
  const line = await tx.shelfCountLine.upsert({
    where: { countId_variantId: { countId, variantId: variant.id } },
    create: { countId, variantId: variant.id, countedQty: 1, shelfQtyAtScan },
    update: { countedQty: { increment: 1 }, shelfQtyAtScan },
    select: { countedQty: true },
  });
  return { message: `${variant.sku} · ${line.countedQty} counted` };
}

export async function setShelfCountQty(tx: Prisma.TransactionClient, user: SessionUser, countId: string, variantId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0) throw new ShelfError("Quantity must be a whole number, 0 or more.");
  const c = await lockShelfCount(tx, countId);
  requireOpen(c);
  await assertActs(tx, user, "stock.count", c.locationId, "count shelves there");
  // Typing a figure in is counting the shelf now — same as a scan.
  const shelfQtyAtScan = await shelfQtyLocked(tx, c.shelfId, variantId);
  await tx.shelfCountLine.upsert({ where: { countId_variantId: { countId, variantId } }, create: { countId, variantId, countedQty: qty, shelfQtyAtScan }, update: { countedQty: qty, shelfQtyAtScan } });
}

export async function cancelShelfCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string): Promise<void> {
  const c = await lockShelfCount(tx, countId);
  requireOpen(c);
  await assertActs(tx, user, "stock.count", c.locationId, "count shelves there");
  await tx.shelfCount.update({ where: { id: countId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}

/** Of these variants, the ones whose figure on this shelf moved after shelf movement `seq`. */
async function movedOnShelfSince(db: Db, shelfId: string, variantIds: string[], seq: bigint): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const rows = await db.shelfMovement.findMany({
    where: { variantId: { in: variantIds }, seq: { gt: seq }, OR: [{ fromShelfId: shelfId }, { toShelfId: shelfId }] },
    distinct: ["variantId"],
    select: { variantId: true },
  });
  return new Set(rows.map((r) => r.variantId));
}

/**
 * Finishes a shelf count. Same rule as a location count (PRD §4.3): each
 * line is compared with the shelf's figure AT ITS LAST SCAN, and the
 * difference is applied to the shelf's figure now — so a sale or a move off
 * the shelf after the scan is never read as missing, and a put-away after
 * it never as extra. Then:
 *   short → off the shelf, into "not on its shelf" (no expense: the dress
 *           may be on another shelf; a manager or a location count settles it)
 *   extra → onto the shelf from Unassigned (or not-on-its-shelf: found),
 *           then from the shelf holding the most; beyond the location's
 *           stock it is reported, not invented (only a location count adds stock)
 * An item the shelf shows that nobody scanned counts as none — unless it
 * moved on this shelf during the count; then it's left as it is.
 */
export async function finishShelfCount(tx: Prisma.TransactionClient, user: SessionUser, countId: string, meta: { request?: Request } = {}) {
  const c = await lockShelfCount(tx, countId);
  requireOpen(c);
  await assertActs(tx, user, "stock.count", c.locationId, "count shelves there");
  const shelf = await tx.shelf.findUniqueOrThrow({ where: { id: c.shelfId }, select: { code: true } });

  type Line = { id: string | null; variantId: string; countedQty: number; shelfQtyAtScan: number | null };
  const lines: Line[] = await tx.shelfCountLine.findMany({ where: { countId }, select: { id: true, variantId: true, countedQty: true, shelfQtyAtScan: true } });
  const unscanned = await tx.shelfStock.findMany({ where: { shelfId: c.shelfId, qty: { gt: 0 }, variantId: { notIn: lines.map((l) => l.variantId) } }, select: { variantId: true } });
  for (const u of unscanned) lines.push({ id: null, variantId: u.variantId, countedQty: 0, shelfQtyAtScan: null });
  lines.sort((a, b) => a.variantId.localeCompare(b.variantId));

  const summary = { missing: 0, placed: 0, unplaced: 0, movedDuringCount: [] as string[], lines: [] as { sku: string; expected: number; counted: number; missing: number; placed: number; unplaced: number }[] };
  for (const line of lines) {
    const now = await shelfQtyLocked(tx, c.shelfId, line.variantId);
    const { sku } = await tx.productVariant.findUniqueOrThrow({ where: { id: line.variantId }, select: { sku: true } });
    if (line.id === null) {
      if ((await movedOnShelfSince(tx, c.shelfId, [line.variantId], c.openedAtSeq)).size > 0) {
        summary.movedDuringCount.push(sku);
        continue;
      }
      line.id = (await tx.shelfCountLine.create({ data: { countId, variantId: line.variantId, countedQty: 0, shelfQtyAtScan: now }, select: { id: true } })).id;
      line.shelfQtyAtScan = now;
    }
    const expected = line.shelfQtyAtScan ?? now;
    const diff = line.countedQty - expected;
    const ctx = { variantId: line.variantId, locationId: c.locationId, actorId: user.id, shelfCountId: countId, note: `Shelf count ${shelf.code}` };
    let missing = 0;
    let placed = 0;
    let unplaced = 0;
    if (diff < 0) {
      missing = Math.min(-diff, now);
      if (missing > 0) await markMissingFromShelf(tx, { ...ctx, shelfId: c.shelfId, qty: missing });
    } else if (diff > 0) {
      const r = await placeOnShelf(tx, { ...ctx, toShelfId: c.shelfId, qty: diff });
      placed = r.placed;
      unplaced = r.unplaced;
    }
    await tx.shelfCountLine.update({ where: { id: line.id }, data: { expectedQty: expected, missingQty: missing, placedQty: placed, unplacedQty: unplaced } });
    summary.missing += missing;
    summary.placed += placed;
    summary.unplaced += unplaced;
    if (diff !== 0) summary.lines.push({ sku, expected, counted: line.countedQty, missing, placed, unplaced });
  }

  const finishedAt = new Date();
  await tx.shelfCount.update({ where: { id: countId }, data: { status: "DONE", finishedById: user.id, finishedAt } });
  await tx.shelf.update({ where: { id: c.shelfId }, data: { lastCountedAt: finishedAt } });
  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "shelf_count.finish",
    entityType: "shelf_count",
    entityId: countId,
    before: { status: "OPEN" },
    after: { status: "DONE", shelf: shelf.code, ...summary },
    request: meta.request,
  });
  return { missing: summary.missing, placed: summary.placed, unplaced: summary.unplaced, movedDuringCount: summary.movedDuringCount.length };
}

export async function getShelfCountView(db: Db, user: SessionUser, countId: string): Promise<ShelfCountView | null> {
  const access = await getLocationAccess(db, user);
  const c = await db.shelfCount.findFirst({
    where: { id: countId, ...(access.all ? {} : { locationId: { in: access.ids } }) },
    include: {
      shelf: { select: { id: true, code: true, location: { select: { id: true, name: true } } } },
      createdBy: { select: { name: true } },
      finishedBy: { select: { name: true } },
      lines: { select: { variantId: true, countedQty: true, shelfQtyAtScan: true, expectedQty: true, missingQty: true, placedQty: true, unplacedQty: true } },
    },
  });
  if (!c) return null;
  const open = c.status === "OPEN";
  // While open: scanned lines vs the shelf at their last scan; the shelf's
  // other items vs now (unless they moved during the count — left alone).
  const live = open ? await db.shelfStock.findMany({ where: { shelfId: c.shelfId, qty: { gt: 0 } }, select: { variantId: true, qty: true } }) : [];
  const liveQty = new Map(live.map((s) => [s.variantId, s.qty]));
  const counted = new Map(c.lines.map((l) => [l.variantId, l]));
  const moved = open ? await movedOnShelfSince(db, c.shelfId, [...liveQty.keys()].filter((id) => !counted.has(id)), c.openedAtSeq) : new Set<string>();
  const info = await variantInfo(db, [...new Set([...counted.keys(), ...liveQty.keys()])]);

  const lines = [...info.entries()]
    .map(([variantId, item]) => {
      const line = counted.get(variantId);
      const movedDuringCount = moved.has(variantId);
      const countedQty = line?.countedQty ?? 0;
      const expected = open ? (line?.shelfQtyAtScan ?? liveQty.get(variantId) ?? 0) : (line?.expectedQty ?? 0);
      return {
        ...item,
        scanned: line !== undefined,
        movedDuringCount,
        counted: countedQty,
        expected,
        difference: movedDuringCount ? 0 : countedQty - expected,
        result: !open && line?.expectedQty !== null && line?.expectedQty !== undefined ? { missing: line.missingQty ?? 0, placed: line.placedQty ?? 0, unplaced: line.unplacedQty ?? 0 } : null,
      };
    })
    .filter((l) => open || counted.has(l.variantId))
    .sort((a, b) => Number(a.difference === 0) - Number(b.difference === 0) || byName(a, b));

  const mayCount = await can(user, "stock.count");
  const may = open && mayCount && canActAt(access, c.locationId);
  return {
    id: c.id,
    status: c.status,
    shelf: { id: c.shelf.id, code: c.shelf.code },
    location: c.shelf.location,
    createdByName: c.createdBy?.name ?? null,
    createdAt: c.createdAt.toISOString(),
    finishedByName: c.finishedBy?.name ?? null,
    finishedAt: c.finishedAt?.toISOString() ?? null,
    lines,
    totals: {
      counted: lines.reduce((a, l) => a + l.counted, 0),
      expected: lines.reduce((a, l) => a + l.expected, 0),
      missing: lines.reduce((a, l) => a + Math.max(0, -l.difference), 0),
      extra: lines.reduce((a, l) => a + Math.max(0, l.difference), 0),
    },
    can: { scan: may, finish: may },
  };
}
