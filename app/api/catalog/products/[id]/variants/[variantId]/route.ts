import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
) {
  const guard = await requirePermission("product.delete");
  if (!guard.ok) return guard.response;

  const { id, variantId } = await params;
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, productId: id } });
  if (!variant) return NextResponse.json({ error: "Variant not found" }, { status: 404 });

  if (variant.stockQty !== 0 || variant.reservedQty !== 0) {
    return NextResponse.json(
      { error: "Variant has stock or reservations. Deactivate it instead of deleting." },
      { status: 409 },
    );
  }

  await prisma.productVariant.delete({ where: { id: variantId } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.variant.delete",
    entityType: "product",
    entityId: id,
    before: { ...variant, weightedAvgCost: variant.weightedAvgCost.toString(), priceOverride: variant.priceOverride?.toString() ?? null },
    request,
  });

  return NextResponse.json({ ok: true });
}
