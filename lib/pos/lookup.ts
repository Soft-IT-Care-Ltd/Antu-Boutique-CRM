import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { computeAllocation } from "@/lib/fulfilment/allocation";
import { normalizeScannedCode } from "@/lib/barcode/scan";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import type { PosTenderMethod } from "@/lib/pos/constants";
import type { PosRecentSale, PosVariantHit } from "@/lib/pos/types";

// The POS finds what to sell two ways: a scanned price tag (its barcode is
// the variant's SKU, exactly — lib/catalog/price-tags.ts) or type-ahead by
// product name, code or SKU. Both return selling price and live stock only;
// cost never leaves the server from here. C3 (CORRECTIONS.md item 11): the
// stock shown is what THIS showroom holds (its location), since that is
// what a POS sale takes — not the shop-wide available figure.

const sellableVariant = {
  isActive: true,
  // P3.3 — packaging material is never sold on its own.
  product: { isActive: true, deletedAt: null, kind: "SELLABLE" },
} satisfies Prisma.ProductVariantWhereInput;

const hitSelect = (locationId: string) =>
  ({
  id: true,
  sku: true,
  locationStocks: { where: { locationId }, select: { qty: true } },
  priceOverride: true,
  size: { select: { name: true, sortOrder: true } },
  color: { select: { name: true, hexCode: true, sortOrder: true } },
  product: { select: { id: true, name: true, code: true, basePrice: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } },
}) satisfies Prisma.ProductVariantSelect;

type HitRow = Prisma.ProductVariantGetPayload<{ select: ReturnType<typeof hitSelect> }>;

/**
 * C5 — per variant, the online orders counting on units at this showroom
 * (the one allocation, lib/fulfilment/allocation.ts): what the POS warns
 * about before selling one of them.
 */
async function heldForOnline(db: Db, variantIds: string[], locationId: string): Promise<Map<string, { orderNo: string; qty: number }[]>> {
  const out = new Map<string, { orderNo: string; qty: number }[]>();
  if (variantIds.length === 0) return out;
  const { lines, orders } = await computeAllocation(db as Prisma.TransactionClient, variantIds);
  const orderNo = new Map(orders.map((o) => [o.id, o.orderNo]));
  for (const line of lines) {
    const here = line.fromLocations.find((f) => f.locationId === locationId)?.qty ?? 0;
    if (here <= 0) continue;
    const list = out.get(line.variantId) ?? [];
    const no = orderNo.get(line.orderId)!;
    const existing = list.find((h) => h.orderNo === no);
    if (existing) existing.qty += here;
    else list.push({ orderNo: no, qty: here });
    out.set(line.variantId, list);
  }
  return out;
}

function toHit(v: HitRow, held: Map<string, { orderNo: string; qty: number }[]>): PosVariantHit {
  return {
    variantId: v.id,
    productId: v.product.id,
    productName: v.product.name,
    productCode: v.product.code,
    sku: v.sku,
    sizeName: v.size.name,
    colorName: v.color.name,
    colorHex: v.color.hexCode,
    price: (v.priceOverride ?? v.product.basePrice).toFixed(2),
    available: v.locationStocks[0]?.qty ?? 0,
    heldForOnline: held.get(v.id) ?? [],
    thumbPath: v.product.images[0]?.thumbPath ?? null,
  };
}

/**
 * A scanned (or typed) code → the one sellable variant whose SKU it is.
 * SKUs are stored uppercase and barcode-safe (lib/barcode/scan.ts), and the
 * scan is normalized the same way, so a tag always finds its variant.
 */
export async function findVariantByCode(db: Db, raw: string, locationId: string): Promise<PosVariantHit | null> {
  const code = normalizeScannedCode(raw);
  if (!code) return null;
  const rows = await db.productVariant.findMany({ where: { ...sellableVariant, sku: { equals: code, mode: "insensitive" } }, select: hitSelect(locationId), take: 2 });
  // A legacy SKU could differ from another only by case; prefer the exact one.
  const row = rows.find((r) => r.sku === code) ?? rows[0];
  return row ? toHit(row, await heldForOnline(db, [row.id], locationId)) : null;
}

/** Type-ahead: every sellable size/colour of the products matching a name, code or SKU. */
export async function searchSellableVariants(db: Db, q: string, locationId: string, limit = 24): Promise<PosVariantHit[]> {
  const term = q.trim();
  const rows = await db.productVariant.findMany({
    where: {
      ...sellableVariant,
      OR: [
        { sku: { contains: term, mode: "insensitive" } },
        { product: { name: { contains: term, mode: "insensitive" } } },
        { product: { code: { contains: term, mode: "insensitive" } } },
      ],
    },
    select: hitSelect(locationId),
    orderBy: [{ product: { name: "asc" } }, { size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
    take: limit,
  });
  const held = await heldForOnline(db, rows.map((r) => r.id), locationId);
  return rows.map((r) => toHit(r, held));
}

/** Today's walk-in sales, newest first, scoped like every order list (an operator sees their own). */
export async function listRecentPosSales(db: Db, user: SessionUser, limit = 8): Promise<PosRecentSale[]> {
  const rows = await db.order.findMany({
    where: scopedWhere({ deletedAt: null, channel: "WALK_IN", createdAt: { gte: dhakaDayStartUtc(todayInDhaka()) } }, user) as Prisma.OrderWhereInput,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      orderNo: true,
      total: true,
      createdAt: true,
      customer: { select: { name: true } },
      _count: { select: { items: true, invoices: true } },
      payments: { where: { OR: [{ kind: "PAYMENT" }, { kind: "STORE_CREDIT", amount: { gt: 0 } }] }, select: { method: true } },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    orderNo: o.orderNo,
    total: o.total.toFixed(2),
    createdAt: o.createdAt.toISOString(),
    customerName: o.customer?.name ?? null,
    itemCount: o._count.items,
    methods: [...new Set(o.payments.map((p) => p.method as PosTenderMethod))],
    hasInvoice: o._count.invoices > 0,
  }));
}
