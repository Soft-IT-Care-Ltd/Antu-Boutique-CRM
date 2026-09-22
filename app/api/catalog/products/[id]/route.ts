import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadProductDetail, serializeProductDetail } from "@/lib/catalog/product-detail";
import { getProductStockSummaries, summaryFor } from "@/lib/catalog/stock-status";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: z.string().trim().min(1).max(20).optional(),
  categoryId: z.string().cuid().nullish(),
  brand: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(4000).nullish(),
  fabric: z.string().trim().max(120).nullish(),
  basePrice: z.coerce.number().nonnegative().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  isActive: z.boolean().optional(),
});

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const product = await loadProductDetail(id);
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const summaries = await getProductStockSummaries([id]);
  const body = { product: serializeProductDetail(product, summaryFor(summaries, id).available) };

  return NextResponse.json(await stripCostFieldsForUser(body, guard.user));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.edit");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.product.findFirst({ where: { id, deletedAt: null } });
  if (!existing) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { categoryId, code, ...rest } = parsed.data;

  if (code && code !== existing.code) {
    const clash = await prisma.product.findUnique({ where: { code } });
    if (clash) return NextResponse.json({ error: "Product code already in use" }, { status: 409 });
  }

  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) return NextResponse.json({ error: "Category not found" }, { status: 400 });
  }

  const product = await prisma.product.update({
    where: { id },
    data: {
      ...rest,
      ...(code !== undefined ? { code } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
    },
    include: { category: { select: { id: true, name: true } } },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.product.update",
    entityType: "product",
    entityId: product.id,
    before: { ...existing, basePrice: existing.basePrice.toString() },
    after: { ...product, basePrice: product.basePrice.toString() },
    request,
  });

  return NextResponse.json(
    await stripCostFieldsForUser({ product: { ...product, basePrice: product.basePrice.toString() } }, guard.user),
  );
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.delete");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.product.findFirst({ where: { id, deletedAt: null } });
  if (!existing) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const product = await prisma.product.update({ where: { id }, data: { deletedAt: new Date() } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.product.trash",
    entityType: "product",
    entityId: id,
    before: { deletedAt: null },
    after: { deletedAt: product.deletedAt },
    request,
  });

  return NextResponse.json({ ok: true });
}
