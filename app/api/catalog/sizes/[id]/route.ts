import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.size.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Size not found" }, { status: 404 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  if (parsed.data.name) {
    const clash = await prisma.size.findUnique({ where: { name: parsed.data.name } });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: "A size with this name already exists" }, { status: 409 });
    }
  }

  const size = await prisma.size.update({ where: { id }, data: parsed.data });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.size.update",
    entityType: "size",
    entityId: size.id,
    before: existing,
    after: size,
    request,
  });

  return NextResponse.json({ size });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.size.findUnique({ where: { id }, include: { _count: { select: { variants: true } } } });
  if (!existing) return NextResponse.json({ error: "Size not found" }, { status: 404 });

  if (existing._count.variants > 0) {
    return NextResponse.json(
      { error: "Size is used by existing variants. Deactivate it instead of deleting." },
      { status: 409 },
    );
  }

  await prisma.size.delete({ where: { id } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.size.delete",
    entityType: "size",
    entityId: id,
    before: existing,
    request,
  });

  return NextResponse.json({ ok: true });
}
