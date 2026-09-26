import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.delete");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.product.findUnique({ where: { id } });
  // Archived by the purge = out of the trash for good (lib/trash/purge.ts).
  if (!existing || !existing.deletedAt || existing.archivedAt) {
    return NextResponse.json({ error: "Product not found in trash" }, { status: 404 });
  }

  const product = await prisma.product.update({ where: { id }, data: { deletedAt: null } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.product.restore",
    entityType: "product",
    entityId: id,
    before: { deletedAt: existing.deletedAt },
    after: { deletedAt: product.deletedAt },
    request,
  });

  return NextResponse.json({ ok: true });
}
