import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  hexCode: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Hex code must look like #RRGGBB")
    .optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.color.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Colour not found" }, { status: 404 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  if (parsed.data.name) {
    const clash = await prisma.color.findUnique({ where: { name: parsed.data.name } });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: "A colour with this name already exists" }, { status: 409 });
    }
  }

  const color = await prisma.color.update({
    where: { id },
    data: { ...parsed.data, hexCode: parsed.data.hexCode?.toUpperCase() },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.color.update",
    entityType: "color",
    entityId: color.id,
    before: existing,
    after: color,
    request,
  });

  return NextResponse.json({ color });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.color.findUnique({ where: { id }, include: { _count: { select: { variants: true } } } });
  if (!existing) return NextResponse.json({ error: "Colour not found" }, { status: 404 });

  if (existing._count.variants > 0) {
    return NextResponse.json(
      { error: "Colour is used by existing variants. Deactivate it instead of deleting." },
      { status: 409 },
    );
  }

  await prisma.color.delete({ where: { id } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.color.delete",
    entityType: "color",
    entityId: id,
    before: existing,
    request,
  });

  return NextResponse.json({ ok: true });
}
