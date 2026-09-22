import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { generateUniqueVariantSku } from "@/lib/catalog/sku";

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

  const [sizes, colors, existingVariants] = await Promise.all([
    prisma.size.findMany({ where: { id: { in: sizeIds } } }),
    prisma.color.findMany({ where: { id: { in: colorIds } } }),
    prisma.productVariant.findMany({ where: { productId: id } }),
  ]);

  if (sizes.length !== sizeIds.length) return NextResponse.json({ error: "One or more sizes not found" }, { status: 400 });
  if (colors.length !== colorIds.length) return NextResponse.json({ error: "One or more colours not found" }, { status: 400 });

  const existingPairs = new Set(existingVariants.map((v) => `${v.sizeId}:${v.colorId}`));

  const toCreate: { sizeId: string; colorId: string; sku: string }[] = [];
  for (const size of sizes) {
    for (const color of colors) {
      if (existingPairs.has(`${size.id}:${color.id}`)) continue;
      const sku = await generateUniqueVariantSku(product.code, size.name, color.name);
      toCreate.push({ sizeId: size.id, colorId: color.id, sku });
    }
  }

  if (toCreate.length > 0) {
    await prisma.productVariant.createMany({
      data: toCreate.map((entry) => ({
        productId: id,
        sizeId: entry.sizeId,
        colorId: entry.colorId,
        sku: entry.sku,
      })),
    });

    await writeAuditLog({
      actorId: guard.user.id,
      action: "catalog.variant.generate",
      entityType: "product",
      entityId: id,
      after: { created: toCreate.map((e) => e.sku) },
      request,
    });
  }

  const variants = await prisma.productVariant.findMany({
    where: { productId: id },
    include: { size: true, color: true },
    orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
  });

  const body = {
    createdCount: toCreate.length,
    variants: variants.map((v) => ({
      ...v,
      weightedAvgCost: v.weightedAvgCost.toString(),
      priceOverride: v.priceOverride?.toString() ?? null,
      available: v.stockQty - v.reservedQty,
    })),
  };

  return NextResponse.json(await stripCostFieldsForUser(body, guard.user));
}
