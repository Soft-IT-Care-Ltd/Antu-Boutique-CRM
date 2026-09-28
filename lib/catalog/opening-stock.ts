import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { lockVariant, recordStockMovement } from "@/lib/inventory/ledger";

// CORRECTIONS.md item 4 — stock entered per location when a product is
// added. The product page shows a stock-in grid: one row per size/colour
// that has never held stock, one column per location, plus a unit cost per
// row. Saving posts OPENING_BALANCE ledger rows per location in one
// transaction (CLAUDE.md rule 2) and the unit cost becomes the variant's
// weighted average cost — the same as the CSV import's opening stock. No
// expense: opening stock was bought before the system existed. Stock is
// never typed into a stock field; after this, it comes in by purchase.

export class OpeningStockError extends Error {}

export type OpeningStockCandidate = { variantId: string; sku: string; sizeName: string; colorName: string; colorHex: string; weightedAvgCost: string };

/** The product's sizes/colours that can still take opening stock: no ledger history at all. */
export async function listOpeningStockCandidates(db: Db, productId: string): Promise<OpeningStockCandidate[]> {
  const rows = await db.productVariant.findMany({
    where: { productId, stockMovements: { none: {} } },
    orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
    select: { id: true, sku: true, weightedAvgCost: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } } },
  });
  return rows.map((v) => ({ variantId: v.id, sku: v.sku, sizeName: v.size.name, colorName: v.color.name, colorHex: v.color.hexCode, weightedAvgCost: v.weightedAvgCost.toFixed(2) }));
}

export type OpeningStockLine = { variantId: string; unitCost: number; quantities: { locationId: string; qty: number }[] };

export async function postOpeningStock(tx: Prisma.TransactionClient, input: { productId: string; lines: OpeningStockLine[] }, actorId: string, request?: Request) {
  const lines = input.lines.map((l) => ({ ...l, quantities: l.quantities.filter((q) => q.qty > 0) })).filter((l) => l.quantities.length > 0);
  if (lines.length === 0) throw new OpeningStockError("Enter a quantity for at least one size/colour and location.");
  const ids = lines.map((l) => l.variantId);
  if (new Set(ids).size !== ids.length) throw new OpeningStockError("A size/colour appears twice.");

  const product = await tx.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { id: true, code: true, name: true } });
  if (!product) throw new OpeningStockError("Product not found.");

  const locationIds = [...new Set(lines.flatMap((l) => l.quantities.map((q) => q.locationId)))];
  const locations = await tx.location.findMany({ where: { id: { in: locationIds }, isActive: true }, select: { id: true, name: true } });
  if (locations.length !== locationIds.length) throw new OpeningStockError("One of the locations doesn't exist or is switched off.");
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  const audit: unknown[] = [];
  let units = 0;
  let valuePaisa = 0;
  // Locked in id order, like every multi-variant stock write.
  for (const line of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    for (const q of line.quantities) {
      if (!Number.isInteger(q.qty) || q.qty < 0) throw new OpeningStockError("Quantities are whole numbers.");
      if (new Set(line.quantities.map((x) => x.locationId)).size !== line.quantities.length) throw new OpeningStockError("A location appears twice on one row.");
    }
    if (!Number.isFinite(line.unitCost) || line.unitCost < 0) throw new OpeningStockError("Enter a unit cost for every row with stock — it becomes the average cost.");
    if (!(await lockVariant(tx, line.variantId))) throw new OpeningStockError("One of the sizes/colours no longer exists.");
    const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: line.variantId }, select: { productId: true, sku: true, _count: { select: { stockMovements: true } } } });
    if (variant.productId !== product.id) throw new OpeningStockError("That size/colour belongs to another product.");
    if (variant._count.stockMovements > 0) throw new OpeningStockError(`${variant.sku} already has stock history — record a purchase or a stock adjustment instead.`);

    const unitCost = fromPaisa(toPaisa(line.unitCost));
    await tx.productVariant.update({ where: { id: line.variantId }, data: { weightedAvgCost: unitCost } });
    for (const q of line.quantities) {
      await recordStockMovement(tx, { variantId: line.variantId, locationId: q.locationId, type: "ADJUSTMENT", qty: q.qty, unitCost, referenceType: "OPENING_BALANCE", actorId, note: "Opening stock" });
      units += q.qty;
      valuePaisa += q.qty * toPaisa(unitCost);
    }
    audit.push({ sku: variant.sku, unitCost, quantities: line.quantities.map((q) => ({ location: locationName.get(q.locationId), qty: q.qty })) });
  }

  await writeAuditLogWith(tx, {
    actorId,
    action: "product.opening_stock",
    entityType: "product",
    entityId: product.id,
    after: { code: product.code, name: product.name, units, valueAtCost: fromPaisa(valuePaisa), lines: audit },
    request,
  });
  return { units, variants: lines.length };
}
