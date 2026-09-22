import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().cuid().nullish(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const categories = await prisma.category.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: true, children: true } } },
  });

  return NextResponse.json({ categories });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { name, parentId, sortOrder, isActive } = parsed.data;

  if (parentId) {
    const parent = await prisma.category.findUnique({ where: { id: parentId } });
    if (!parent) {
      return NextResponse.json({ error: "Parent category not found" }, { status: 400 });
    }
    if (parent.parentId) {
      return NextResponse.json({ error: "Categories support only one level of nesting" }, { status: 400 });
    }
  }

  const category = await prisma.category.create({
    data: { name, parentId: parentId ?? null, sortOrder, isActive },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.category.create",
    entityType: "category",
    entityId: category.id,
    after: category,
    request,
  });

  return NextResponse.json({ category }, { status: 201 });
}
