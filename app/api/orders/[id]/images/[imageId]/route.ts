import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { canManageOrderImages } from "@/lib/orders/access";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

async function loadOrderForImageMutation(orderId: string, imageId: string, user: Parameters<typeof scopedWhere>[1]) {
  const order = await prisma.order.findFirst({
    where: scopedWhere({ id: orderId, deletedAt: null }, user),
    select: { id: true, createdById: true, teamId: true },
  });
  if (!order) return { order: null, image: null };
  const image = await prisma.orderImage.findFirst({ where: { id: imageId, orderId, deletedAt: null } });
  return { order, image };
}

const patchSchema = z.object({
  caption: z.string().trim().max(300).nullish(),
  orderItemId: z.string().cuid().nullish(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> },
) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const { id, imageId } = await params;
  const { order, image } = await loadOrderForImageMutation(id, imageId, guard.user);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!image) return NextResponse.json({ error: "Image not found" }, { status: 404 });
  if (!canManageOrderImages(guard.user, order)) {
    return NextResponse.json({ error: "You can't edit photos on this order" }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { caption, orderItemId } = parsed.data;

  if (orderItemId) {
    const item = await prisma.orderItem.findFirst({ where: { id: orderItemId, orderId: id } });
    if (!item) return NextResponse.json({ error: "That line item doesn't belong to this order" }, { status: 400 });
  }

  const updated = await prisma.orderImage.update({
    where: { id: imageId },
    data: {
      ...(caption !== undefined ? { caption: caption || null } : {}),
      ...(orderItemId !== undefined ? { orderItemId: orderItemId || null } : {}),
    },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "order.image.update",
    entityType: "order",
    entityId: id,
    before: { caption: image.caption, orderItemId: image.orderItemId },
    after: { caption: updated.caption, orderItemId: updated.orderItemId },
    request,
  });

  return NextResponse.json({
    image: {
      id: updated.id,
      orderItemId: updated.orderItemId,
      filePath: updated.filePath,
      thumbPath: updated.thumbPath,
      caption: updated.caption,
      uploadedAt: updated.uploadedAt.toISOString(),
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> },
) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const { id, imageId } = await params;
  const { order, image } = await loadOrderForImageMutation(id, imageId, guard.user);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!image) return NextResponse.json({ error: "Image not found" }, { status: 404 });
  if (!canManageOrderImages(guard.user, order)) {
    return NextResponse.json({ error: "You can't delete photos on this order" }, { status: 403 });
  }

  // Soft delete (PRD §5.1: order_images.deleted_at), not a file-system
  // removal — the nightly trash-purge cron (P5.1) is what eventually
  // reclaims the on-disk file, same lifecycle as orders/customers/products.
  await prisma.orderImage.update({ where: { id: imageId }, data: { deletedAt: new Date() } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "order.image.delete",
    entityType: "order",
    entityId: id,
    before: { deletedAt: null },
    after: { imageId, deletedAt: new Date().toISOString() },
    request,
  });

  return NextResponse.json({ ok: true });
}
