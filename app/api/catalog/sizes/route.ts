import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { SIZE_CODE_MESSAGE, SIZE_CODE_PATTERN } from "@/lib/catalog/codes";
import { generateSizeCode } from "@/lib/catalog/sku";

const createSchema = z.object({
  // PRD §4.2 SKU code — suggested from the name when left blank.
  code: z.string().trim().toUpperCase().regex(SIZE_CODE_PATTERN, SIZE_CODE_MESSAGE).optional(),
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

  const code = parsed.data.code || (await generateSizeCode(prisma, parsed.data.name));
  if (await prisma.size.findUnique({ where: { code } })) return NextResponse.json({ error: `Size code ${code} is already used` }, { status: 409 });

  const size = await prisma.size.create({ data: { ...parsed.data, code } });

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
