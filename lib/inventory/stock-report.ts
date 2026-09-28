import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { LOW_STOCK_DEFAULT_SQL } from "@/lib/catalog/low-stock-threshold";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { variantStockStatus, type StockStatusFilter } from "@/lib/inventory/constants";
import { rollUpProductStock } from "@/lib/inventory/low-stock";
import type { LowStockProductAlert, StockReportRow, StockReportTotals } from "@/lib/inventory/types";

// PRD §4.15 R4 — per variant: on hand, reserved, available, value at cost,
// low-stock flag. Raw SQL because the status filter compares two columns
// (stockQty − reservedQty vs lowStockThreshold), which Prisma's query
// builder can't express, and it has to filter BEFORE pagination.
//
// Rows carry weightedAvgCost / valueAtCost unconditionally; the route and
// page strip them with stripCostFields for any caller without
// product.cost.view (CLAUDE.md rule 5).

export type StockReportQuery = {
  q?: string;
  categoryId?: string;
  /** C3 — only variants that hold stock (≠ 0) at this location; on hand and value are that location's. */
  locationId?: string;
  status: StockStatusFilter;
  page: number;
  pageSize: number;
};

type RawRow = {
  variantId: string;
  productId: string;
  productName: string;
  productCode: string;
  categoryName: string | null;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  isActive: boolean;
  stockQty: number;
  reservedQty: number;
  threshold: number;
  weightedAvgCost: Prisma.Decimal;
  byLocation: { locationId: string; name: string; qty: number }[];
  atLocation: number | null;
};

const AVAILABLE = Prisma.sql`(v."stockQty" - v."reservedQty")`;
// ::int (inside LOW_STOCK_DEFAULT_SQL) — a bound JS number arrives as bigint,
// and COALESCE would then hand back a BigInt that JSON can't carry (every
// stock route 500'd on it).
const THRESHOLD = Prisma.sql`COALESCE(v."lowStockThreshold", ${LOW_STOCK_DEFAULT_SQL})`;

// C3 — each variant's stock per location (only the non-zero ones), and the
// chosen location's own figure.
const BY_LOCATION = Prisma.sql`COALESCE((
  SELECT json_agg(json_build_object('locationId', vs."locationId", 'name', l."name", 'qty', vs."qty") ORDER BY l."sortOrder", l."name")
  FROM "variant_stocks" vs JOIN "locations" l ON l."id" = vs."locationId"
  WHERE vs."variantId" = v."id" AND vs."qty" <> 0
), '[]'::json)`;
const atLocationSql = (locationId: string | undefined) =>
  locationId ? Prisma.sql`COALESCE((SELECT vs."qty" FROM "variant_stocks" vs WHERE vs."variantId" = v."id" AND vs."locationId" = ${locationId}), 0)` : Prisma.sql`NULL::int`;

function whereClause(query: Pick<StockReportQuery, "q" | "categoryId" | "status" | "locationId">): Prisma.Sql {
  // An inactive variant still shows while it physically holds stock —
  // otherwise its value would silently drop out of the stock valuation.
  const conditions: Prisma.Sql[] = [Prisma.sql`p."deletedAt" IS NULL`, Prisma.sql`(v."isActive" = true OR v."stockQty" <> 0)`];

  if (query.q) {
    const like = `%${query.q}%`;
    conditions.push(Prisma.sql`(p."name" ILIKE ${like} OR p."code" ILIKE ${like} OR v."sku" ILIKE ${like})`);
  }
  if (query.categoryId) {
    conditions.push(Prisma.sql`(p."categoryId" = ${query.categoryId} OR cat."parentId" = ${query.categoryId})`);
  }
  if (query.locationId) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "variant_stocks" vs WHERE vs."variantId" = v."id" AND vs."locationId" = ${query.locationId} AND vs."qty" <> 0)`);
  }
  if (query.status === "out") conditions.push(Prisma.sql`${AVAILABLE} <= 0`);
  if (query.status === "low") conditions.push(Prisma.sql`${AVAILABLE} > 0 AND ${AVAILABLE} <= ${THRESHOLD}`);
  if (query.status === "in") conditions.push(Prisma.sql`${AVAILABLE} > ${THRESHOLD}`);

  return Prisma.join(conditions, " AND ");
}

const FROM = Prisma.sql`
  FROM "product_variants" v
  JOIN "products" p ON p."id" = v."productId"
  JOIN "sizes" s ON s."id" = v."sizeId"
  JOIN "colors" c ON c."id" = v."colorId"
  LEFT JOIN "categories" cat ON cat."id" = p."categoryId"
`;

function toRow(r: RawRow): StockReportRow {
  const available = r.stockQty - r.reservedQty;
  // Value of what is physically on the shelf (reserved units included —
  // they're still ours until packed) — at the chosen location when the
  // report is filtered to one. Negative stock is valued at zero.
  const valuePaisa = Math.max(r.atLocation ?? r.stockQty, 0) * toPaisa(r.weightedAvgCost);
  return {
    variantId: r.variantId,
    productId: r.productId,
    productName: r.productName,
    productCode: r.productCode,
    categoryName: r.categoryName,
    sku: r.sku,
    sizeName: r.sizeName,
    colorName: r.colorName,
    colorHex: r.colorHex,
    isActive: r.isActive,
    stockQty: r.stockQty,
    reservedQty: r.reservedQty,
    available,
    byLocation: r.byLocation.map((b) => ({ ...b, qty: Number(b.qty) })),
    atLocation: r.atLocation === null ? null : Number(r.atLocation),
    threshold: r.threshold,
    status: variantStockStatus(available, r.threshold),
    weightedAvgCost: r.weightedAvgCost.toString(),
    valueAtCost: fromPaisa(valuePaisa),
  };
}

export async function getStockReport(query: StockReportQuery): Promise<{ items: StockReportRow[]; total: number; totals: StockReportTotals }> {
  const where = whereClause(query);
  const atLocation = atLocationSql(query.locationId);

  const [rows, aggregate] = await Promise.all([
    prisma.$queryRaw<RawRow[]>`
      SELECT v."id" AS "variantId", p."id" AS "productId", p."name" AS "productName", p."code" AS "productCode",
             cat."name" AS "categoryName", v."sku", s."name" AS "sizeName", c."name" AS "colorName", c."hexCode" AS "colorHex",
             v."isActive", v."stockQty", v."reservedQty", ${THRESHOLD} AS "threshold", v."weightedAvgCost",
             ${BY_LOCATION} AS "byLocation", ${atLocation} AS "atLocation"
      ${FROM}
      WHERE ${where}
      ORDER BY p."name" ASC, s."sortOrder" ASC, c."sortOrder" ASC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    `,
    prisma.$queryRaw<{ variants: bigint; onHand: bigint | null; reserved: bigint | null; atLocation: bigint | null; value: Prisma.Decimal | null }[]>`
      SELECT COUNT(*) AS "variants",
             SUM(v."stockQty") AS "onHand",
             SUM(v."reservedQty") AS "reserved",
             SUM(${atLocation}) AS "atLocation",
             SUM(GREATEST(${query.locationId ? atLocation : Prisma.sql`v."stockQty"`}, 0) * v."weightedAvgCost") AS "value"
      ${FROM}
      WHERE ${where}
    `,
  ]);

  const agg = aggregate[0];
  const onHand = Number(agg?.onHand ?? 0);
  const reserved = Number(agg?.reserved ?? 0);
  const total = Number(agg?.variants ?? 0);

  return {
    items: rows.map(toRow),
    total,
    totals: {
      variants: total,
      onHand,
      reserved,
      available: onHand - reserved,
      atLocation: query.locationId ? Number(agg?.atLocation ?? 0) : null,
      valueAtCost: fromPaisa(toPaisa(agg?.value ?? 0)),
    },
  };
}

/**
 * Every active product with at least one LOW/OUT active variant, with the
 * product-level roll-up message. Only counts active variants of active,
 * non-deleted products — a discontinued colour shouldn't nag forever.
 */
export async function getLowStockAlerts(): Promise<LowStockProductAlert[]> {
  const rows = await prisma.$queryRaw<(RawRow & { sizeSort: number; colorSort: number })[]>`
    SELECT v."id" AS "variantId", p."id" AS "productId", p."name" AS "productName", p."code" AS "productCode",
           cat."name" AS "categoryName", v."sku", s."name" AS "sizeName", c."name" AS "colorName", c."hexCode" AS "colorHex",
           v."isActive", v."stockQty", v."reservedQty", ${THRESHOLD} AS "threshold", v."weightedAvgCost",
           '[]'::json AS "byLocation", NULL::int AS "atLocation"
    ${FROM}
    WHERE p."deletedAt" IS NULL AND p."isActive" = true AND v."isActive" = true
      AND p."id" IN (
        SELECT v2."productId" FROM "product_variants" v2
        WHERE v2."isActive" = true
          AND (v2."stockQty" - v2."reservedQty") <= COALESCE(v2."lowStockThreshold", ${LOW_STOCK_DEFAULT_SQL})
      )
    ORDER BY p."name" ASC, s."sortOrder" ASC, c."sortOrder" ASC
  `;

  const byProduct = new Map<string, RawRow[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }

  const alerts: LowStockProductAlert[] = [];
  for (const [productId, variants] of byProduct) {
    const rollUp = rollUpProductStock(
      variants.map((v) => ({
        variantId: v.variantId,
        sku: v.sku,
        sizeName: v.sizeName,
        colorName: v.colorName,
        colorHex: v.colorHex,
        available: v.stockQty - v.reservedQty,
        threshold: v.threshold,
      })),
    );
    if (!rollUp) continue;
    alerts.push({
      productId,
      productName: variants[0].productName,
      productCode: variants[0].productCode,
      categoryName: variants[0].categoryName,
      totalVariants: variants.length,
      ...rollUp,
    });
  }

  // Most urgent first: products with more out-of-stock variants, then more low ones.
  return alerts.sort((a, b) => b.outCount - a.outCount || b.lowCount - a.lowCount || a.productName.localeCompare(b.productName));
}
