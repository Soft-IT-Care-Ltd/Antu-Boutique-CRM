import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { MAX_PRODUCT_IMAGES } from "@/lib/catalog/constants";
import { isAllowedImageMime, MAX_UPLOAD_BYTES, saveCompressedImage } from "@/lib/uploads/storage";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.edit");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    include: { _count: { select: { images: true } } },
  });
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const formData = await request.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "No files provided" }, { status: 400 });

  if (product._count.images + files.length > MAX_PRODUCT_IMAGES) {
    return NextResponse.json({ error: `A product can have at most ${MAX_PRODUCT_IMAGES} images` }, { status: 400 });
  }

  for (const file of files) {
    if (!isAllowedImageMime(file.type)) {
      return NextResponse.json({ error: `Unsupported file type: ${file.type || file.name}` }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: `${file.name} exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit` }, { status: 400 });
    }
  }

  const created = [];
  let sortOrder = product._count.images;
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const saved = await saveCompressedImage(buffer, file.type, `products/${id}`);
    const image = await prisma.productImage.create({
      data: {
        productId: id,
        filePath: saved.filePath,
        thumbPath: saved.thumbPath,
        sortOrder,
      },
    });
    created.push(image);
    sortOrder += 1;
  }

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.product.images.upload",
    entityType: "product",
    entityId: id,
    after: { imageIds: created.map((i) => i.id) },
    request,
  });

  return NextResponse.json({ images: created }, { status: 201 });
}
