import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().cuid().nullish(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { name, parentId, sortOrder, isActive } = parsed.data;

  if (parentId !== undefined && parentId !== null) {
    if (parentId === id) {
      return NextResponse.json({ error: "A category cannot be its own parent" }, { status: 400 });
    }
    const parent = await prisma.category.findUnique({ where: { id: parentId } });
    if (!parent) return NextResponse.json({ error: "Parent category not found" }, { status: 400 });
    if (parent.parentId) {
      return NextResponse.json({ error: "Categories support only one level of nesting" }, { status: 400 });
    }
    const childCount = await prisma.category.count({ where: { parentId: id } });
    if (childCount > 0) {
      return NextResponse.json({ error: "A category with sub-categories cannot become a sub-category itself" }, { status: 400 });
    }
  }

  const category = await prisma.category.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.category.update",
    entityType: "category",
    entityId: category.id,
    before: existing,
    after: category,
    request,
  });

  return NextResponse.json({ category });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true, children: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  if (existing._count.products > 0 || existing._count.children > 0) {
    return NextResponse.json(
      { error: "Category is in use by products or sub-categories. Deactivate it instead of deleting." },
      { status: 409 },
    );
  }

  await prisma.category.delete({ where: { id } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.category.delete",
    entityType: "category",
    entityId: id,
    before: existing,
    request,
  });

  return NextResponse.json({ ok: true });
}
