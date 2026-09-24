import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { searchTagVariants, tagsForProduct, tagsForPurchase } from "@/lib/catalog/price-tags";
import { badRequest, idString } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";

// What to put on the tag list: a whole product, a whole purchase, or a
// search. Selling price and stock counts only — no cost.
const querySchema = z
  .object({ productId: idString.optional(), purchaseId: idString.optional(), q: z.string().trim().min(1).max(100).optional() })
  .refine((d) => [d.productId, d.purchaseId, d.q].filter(Boolean).length === 1, "Give exactly one of productId, purchaseId or q");

export async function GET(request: NextRequest) {
  const guard = await requirePermission("product.tags.print");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const { productId, purchaseId, q } = parsed.data;

  if (purchaseId) {
    const items = await tagsForPurchase(prisma, purchaseId);
    if (!items) return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
    return NextResponse.json({ items });
  }
  return NextResponse.json({ items: productId ? await tagsForProduct(prisma, productId) : await searchTagVariants(prisma, q!) });
}
