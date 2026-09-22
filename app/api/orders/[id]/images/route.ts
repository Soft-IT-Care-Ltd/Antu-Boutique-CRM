import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { canManageOrderImages } from "@/lib/orders/access";
import { MAX_ORDER_IMAGES } from "@/lib/orders/constants";
import { isAllowedImageMime, MAX_UPLOAD_BYTES, saveCompressedImage } from "@/lib/uploads/storage";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

// PRD §4.6 section 3: one file per request (so a paste or a single drag can
// carry its own optional caption/line-item tag), up to MAX_ORDER_IMAGES per
// order, added any time after creation — this field never blocks an order.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const order = await prisma.order.findFirst({
    where: scopedWhere({ id, deletedAt: null }, guard.user),
    select: { id: true, orderNo: true, createdById: true, teamId: true, _count: { select: { images: { where: { deletedAt: null } } } } },
  });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  if (!canManageOrderImages(guard.user, order)) {
    return NextResponse.json({ error: "You can't add photos to this order" }, { status: 403 });
  }

  if (order._count.images >= MAX_ORDER_IMAGES) {
    return NextResponse.json({ error: `An order can have at most ${MAX_ORDER_IMAGES} reference images` }, { status: 400 });
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });

  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!isAllowedImageMime(file.type)) {
    return NextResponse.json({ error: `Unsupported file type: ${file.type || file.name}` }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `${file.name} exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit` }, { status: 400 });
  }

  const caption = formData.get("caption");
  const orderItemId = formData.get("orderItemId");

  if (typeof orderItemId === "string" && orderItemId) {
    const item = await prisma.orderItem.findFirst({ where: { id: orderItemId, orderId: id } });
    if (!item) return NextResponse.json({ error: "That line item doesn't belong to this order" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await saveCompressedImage(buffer, file.type, `orders/${order.orderNo}`);

  const image = await prisma.orderImage.create({
    data: {
      orderId: id,
      orderItemId: typeof orderItemId === "string" && orderItemId ? orderItemId : null,
      filePath: saved.filePath,
      thumbPath: saved.thumbPath,
      caption: typeof caption === "string" && caption.trim() ? caption.trim() : null,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
      uploadedById: guard.user.id,
    },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "order.image.upload",
    entityType: "order",
    entityId: id,
    after: { imageId: image.id, orderItemId: image.orderItemId },
    request,
  });

  return NextResponse.json(
    {
      image: {
        id: image.id,
        orderItemId: image.orderItemId,
        filePath: image.filePath,
        thumbPath: image.thumbPath,
        caption: image.caption,
        uploadedAt: image.uploadedAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
