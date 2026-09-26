import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { LOW_STOCK_DEFAULT_SQL } from "@/lib/catalog/low-stock-threshold";

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export type ProductStockSummary = {
  available: number;
  hasLowVariant: boolean;
  status: StockStatus;
};

type Row = { productId: string; available: bigint | number; hasLow: boolean };

/**
 * One roll-up per product: total available (stock - reserved) across active
 * variants, whether any single variant is at/under its low-stock threshold,
 * and the resulting badge status. Products with zero active variants are
 * absent from the map — callers should treat a miss as OUT_OF_STOCK.
 *
 * Raw SQL because Prisma's query builder can't compare two columns
 * (stock_qty - reserved_qty <= low_stock_threshold) in a WHERE/aggregate.
 */
export async function getProductStockSummaries(
  productIds?: string[],
): Promise<Map<string, ProductStockSummary>> {
  const rows = await prisma.$queryRaw<Row[]>(
    productIds && productIds.length > 0
      ? Prisma.sql`
          SELECT "productId",
                 SUM("stockQty" - "reservedQty") AS available,
                 BOOL_OR(("stockQty" - "reservedQty") <= COALESCE("lowStockThreshold", ${LOW_STOCK_DEFAULT_SQL})) AS "hasLow"
          FROM product_variants
          WHERE "isActive" = true AND "productId" IN (${Prisma.join(productIds)})
          GROUP BY "productId"
        `
      : Prisma.sql`
          SELECT "productId",
                 SUM("stockQty" - "reservedQty") AS available,
                 BOOL_OR(("stockQty" - "reservedQty") <= COALESCE("lowStockThreshold", ${LOW_STOCK_DEFAULT_SQL})) AS "hasLow"
          FROM product_variants
          WHERE "isActive" = true
          GROUP BY "productId"
        `,
  );

  const map = new Map<string, ProductStockSummary>();
  for (const row of rows) {
    const available = Number(row.available);
    const status: StockStatus = available <= 0 ? "OUT_OF_STOCK" : row.hasLow ? "LOW_STOCK" : "IN_STOCK";
    map.set(row.productId, { available, hasLowVariant: row.hasLow, status });
  }
  return map;
}

export function summaryFor(map: Map<string, ProductStockSummary>, productId: string): ProductStockSummary {
  return map.get(productId) ?? { available: 0, hasLowVariant: false, status: "OUT_OF_STOCK" };
}

/** Product ids matching a stock-status filter, for use in a `{ id: { in: [...] } }` where clause. */
export async function productIdsWithStockStatus(status: StockStatus): Promise<string[]> {
  const map = await getProductStockSummaries();
  const ids: string[] = [];
  for (const [productId, summary] of map) {
    if (summary.status === status) ids.push(productId);
  }
  // OUT_OF_STOCK also includes products with no active variants at all,
  // which never appear in the aggregate above — those are added by the caller.
  return ids;
}
