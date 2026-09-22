import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

const createSchema = z.object({
  name: z.string().trim().min(1).max(30),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const sizes = await prisma.size.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { variants: true } } },
  });

  return NextResponse.json({ sizes });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const existing = await prisma.size.findUnique({ where: { name: parsed.data.name } });
  if (existing) return NextResponse.json({ error: "A size with this name already exists" }, { status: 409 });

  const size = await prisma.size.create({ data: parsed.data });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.size.create",
    entityType: "size",
    entityId: size.id,
    after: size,
    request,
  });

  return NextResponse.json({ size }, { status: 201 });
}
