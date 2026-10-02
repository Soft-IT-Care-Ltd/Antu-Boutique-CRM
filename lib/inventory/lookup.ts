import "server-only";

import type { Prisma } from "@prisma/client";

import { normalizeScannedCode } from "@/lib/barcode/scan";
import type { Db } from "@/lib/db/tx";
import { listLocations } from "@/lib/locations/service";
import { shelfWhereabouts } from "@/lib/shelves/service";
import type { StockLookupItem } from "@/lib/inventory/types";

// CORRECTIONS.md item 2 — stock lookup: type or scan a SKU, or search a
// name → every location's quantity, in transit, reserved and available.
// Open to every inventory.view role (a salesperson tells the customer where
// a dress is), so it carries no cost at all. A scanned or typed SKU that
// matches exactly comes back alone, before any name match.

const select = {
  id: true,
  sku: true,
  isActive: true,
  stockQty: true,
  inTransitQty: true,
  reservedQty: true,
  priceOverride: true,
  size: { select: { name: true, sortOrder: true } },
  color: { select: { name: true, hexCode: true, sortOrder: true } },
  locationStocks: { select: { locationId: true, qty: true } },
  product: { select: { id: true, name: true, code: true, kind: true, basePrice: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } },
} satisfies Prisma.ProductVariantSelect;

const live = { product: { deletedAt: null } } satisfies Prisma.ProductVariantWhereInput;

export async function lookupStock(db: Db, raw: string, limit = 30): Promise<{ exact: boolean; items: StockLookupItem[] }> {
  const term = raw.trim();
  if (!term) return { exact: false, items: [] };
  const locations = await listLocations(db);
  // A switched-off location still shows while it holds stock.
  const shown = (qtyAt: Map<string, number>) => locations.filter((l) => l.isActive || (qtyAt.get(l.id) ?? 0) !== 0);

  const toItem = (v: Prisma.ProductVariantGetPayload<{ select: typeof select }>): StockLookupItem => {
    const qtyAt = new Map(v.locationStocks.map((s) => [s.locationId, s.qty]));
    return {
      variantId: v.id,
      productId: v.product.id,
      productName: v.product.name,
      productCode: v.product.code,
      isPackaging: v.product.kind === "COMPONENT_ONLY",
      sku: v.sku,
      sizeName: v.size.name,
      colorName: v.color.name,
      colorHex: v.color.hexCode,
      isActive: v.isActive,
      price: v.product.kind === "COMPONENT_ONLY" ? null : (v.priceOverride ?? v.product.basePrice).toFixed(2),
      thumbPath: v.product.images[0]?.thumbPath ?? null,
      locations: shown(qtyAt).map((l) => ({ locationId: l.id, name: l.name, type: l.type, isPackingHub: l.isPackingHub, hasPos: l.hasPos, qty: qtyAt.get(l.id) ?? 0, shelves: null, unassigned: 0, notOnShelf: 0 })),
      // C4 — on the road between locations (part of the total, at no location).
      inTransit: v.inTransitQty,
      total: v.stockQty,
      reserved: v.reservedQty,
      available: v.stockQty - v.reservedQty,
    };
  };

  const code = normalizeScannedCode(term);
  if (code) {
    const exact = await db.productVariant.findMany({ where: { ...live, sku: { equals: code, mode: "insensitive" } }, select, take: 2 });
    const hit = exact.find((v) => v.sku === code) ?? exact[0];
    if (hit) return { exact: true, items: await withShelves(db, [toItem(hit)]) };
  }

  const rows = await db.productVariant.findMany({
    where: {
      ...live,
      OR: [
        { sku: { contains: term, mode: "insensitive" } },
        { product: { name: { contains: term, mode: "insensitive" } } },
        { product: { code: { contains: term, mode: "insensitive" } } },
      ],
    },
    select,
    orderBy: [{ product: { name: "asc" } }, { size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
    take: limit,
  });
  return { exact: false, items: await withShelves(db, rows.map(toItem)) };
}

/** C4b — each shelf-using location's shelves, Unassigned and not-on-its-shelf. */
async function withShelves(db: Db, items: StockLookupItem[]): Promise<StockLookupItem[]> {
  const where = await shelfWhereabouts(db, items.map((i) => i.variantId));
  for (const item of items) {
    for (const loc of item.locations) {
      const w = where.get(item.variantId)?.find((x) => x.locationId === loc.locationId);
      if (!w) continue;
      loc.shelves = w.shelves.map((s) => ({ code: s.code, qty: s.qty }));
      loc.unassigned = w.unassigned;
      loc.notOnShelf = w.notOnShelf;
    }
  }
  return items;
}
