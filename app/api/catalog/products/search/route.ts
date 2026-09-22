import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import type { ProductSearchResult } from "@/lib/orders/types";

// Lightweight product+variant typeahead for the order item picker (PRD
// §4.6 section 2: "Product search by name or SKU -> pick variant"). Kept in
// the catalog namespace (not lib/orders) so POS (P3.1) can reuse it as-is —
// it needs the exact same "sellable variant with an effective price and
// live available stock" shape.
//
// Outfit sets (PRD §4.2) are not included here yet — they don't exist in
// the schema until P3.3; a comment there should point back to this route.

const querySchema = z.object({
  q: z.string().trim().min(1),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { q } = parsed.data;

  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { variants: { some: { sku: { contains: q, mode: "insensitive" }, isActive: true } } },
      ],
    },
    take: 8,
    orderBy: { name: "asc" },
    include: {
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
      variants: {
        where: { isActive: true },
        include: { size: true, color: true },
        orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
      },
    },
  });

  const results: ProductSearchResult[] = products.map((product) => ({
    id: product.id,
    code: product.code,
    name: product.name,
    thumbPath: product.images[0]?.thumbPath ?? null,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      sizeName: variant.size.name,
      colorName: variant.color.name,
      colorHex: variant.color.hexCode,
      effectivePrice: (variant.priceOverride ?? product.basePrice).toString(),
      available: variant.stockQty - variant.reservedQty,
      isActive: variant.isActive,
      weightedAvgCost: variant.weightedAvgCost.toString(),
    })),
  }));

  return NextResponse.json(await stripCostFieldsForUser({ products: results }, guard.user));
}
