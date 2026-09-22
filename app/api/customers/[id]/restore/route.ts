import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("customer.delete");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.customer.findFirst({ where: scopedWhere({ id }, guard.user) });
  if (!existing || !existing.deletedAt) {
    return NextResponse.json({ error: "Customer not found in trash" }, { status: 404 });
  }

  const customer = await prisma.customer.update({ where: { id }, data: { deletedAt: null } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "customer.restore",
    entityType: "customer",
    entityId: id,
    before: { deletedAt: existing.deletedAt },
    after: { deletedAt: customer.deletedAt },
    request,
  });

  return NextResponse.json({ ok: true });
}
