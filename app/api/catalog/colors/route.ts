import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { COLOR_CODE_MESSAGE, COLOR_CODE_PATTERN } from "@/lib/catalog/codes";
import { generateColorCode } from "@/lib/catalog/sku";

const createSchema = z.object({
  // PRD §4.2 SKU code — suggested from the name when left blank.
  code: z.string().trim().toUpperCase().regex(COLOR_CODE_PATTERN, COLOR_CODE_MESSAGE).optional(),
  name: z.string().trim().min(1).max(40),
  hexCode: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Hex code must look like #RRGGBB"),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const colors = await prisma.color.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { variants: true } } },
  });

  return NextResponse.json({ colors });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const existing = await prisma.color.findUnique({ where: { name: parsed.data.name } });
  if (existing) return NextResponse.json({ error: "A colour with this name already exists" }, { status: 409 });

  const code = parsed.data.code || (await generateColorCode(prisma, parsed.data.name));
  if (await prisma.color.findUnique({ where: { code } })) return NextResponse.json({ error: `Colour code ${code} is already used` }, { status: 409 });

  const color = await prisma.color.create({ data: { ...parsed.data, code, hexCode: parsed.data.hexCode.toUpperCase() } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.color.create",
    entityType: "color",
    entityId: color.id,
    after: color,
    request,
  });

  return NextResponse.json({ color }, { status: 201 });
}
