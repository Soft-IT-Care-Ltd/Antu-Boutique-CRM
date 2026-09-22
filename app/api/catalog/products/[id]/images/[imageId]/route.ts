import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { deleteUploadedFile } from "@/lib/uploads/storage";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> },
) {
  const guard = await requirePermission("product.edit");
  if (!guard.ok) return guard.response;

  const { id, imageId } = await params;
  const image = await prisma.productImage.findFirst({ where: { id: imageId, productId: id } });
  if (!image) return NextResponse.json({ error: "Image not found" }, { status: 404 });

  await prisma.productImage.delete({ where: { id: imageId } });
  await Promise.all([deleteUploadedFile(image.filePath), deleteUploadedFile(image.thumbPath)]);

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.product.image.delete",
    entityType: "product",
    entityId: id,
    before: image,
    request,
  });

  return NextResponse.json({ ok: true });
}
