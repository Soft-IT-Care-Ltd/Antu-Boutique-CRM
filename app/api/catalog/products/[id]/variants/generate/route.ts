import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { generateVariants, isUniqueViolation, RACE_MESSAGE, SkuError } from "@/lib/catalog/sku";

// PRD §4.2 — the variant matrix screen: pick sizes × colours, generate every
// combination at once. Only fills in combos that don't exist yet; existing
// variants (and their stock) are left untouched.

const bodySchema = z.object({
  sizeIds: z.array(z.string().cuid()).min(1),
  colorIds: z.array(z.string().cuid()).min(1),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.create");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null } });
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { sizeIds, colorIds } = parsed.data;

  const [sizes, colors] = await Promise.all([
    prisma.size.findMany({ where: { id: { in: sizeIds } } }),
    prisma.color.findMany({ where: { id: { in: colorIds } } }),
  ]);

  if (sizes.length !== sizeIds.length) return NextResponse.json({ error: "One or more sizes not found" }, { status: 400 });
  if (colors.length !== colorIds.length) return NextResponse.json({ error: "One or more colours not found" }, { status: 400 });

  // SKU = product + size + colour code (PRD §4.2). Every SKU is checked
  // before any is written; a clash with another product's SKU moves this
  // product to a free code (lib/catalog/sku.ts), so a clash never surfaces
  // as a database error.
  let result;
  try {
    result = await generateVariants(prisma, { productId: id, sizes, colors, actorId: guard.user.id, request });
  } catch (error) {
    if (error instanceof SkuError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (isUniqueViolation(error)) return NextResponse.json({ error: RACE_MESSAGE }, { status: 409 });
    throw error;
  }

  const variants = await prisma.productVariant.findMany({
    where: { productId: id },
    include: { size: true, color: true },
    orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
  });

  const body = {
    createdCount: result.created.length,
    productCode: result.codeChange?.to ?? product.code,
    notice: result.notice,
    variants: variants.map((v) => ({
      ...v,
      weightedAvgCost: v.weightedAvgCost.toString(),
      priceOverride: v.priceOverride?.toString() ?? null,
      available: v.stockQty - v.reservedQty,
    })),
  };

  return NextResponse.json(await stripCostFieldsForUser(body, guard.user));
}
