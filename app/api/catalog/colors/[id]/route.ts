import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { COLOR_CODE_MESSAGE, COLOR_CODE_PATTERN } from "@/lib/catalog/codes";
import { countLockedVariants, isUniqueViolation, RACE_MESSAGE, regenerateSkus, SkuError } from "@/lib/catalog/sku";

const updateSchema = z.object({
  code: z.string().trim().toUpperCase().regex(COLOR_CODE_PATTERN, COLOR_CODE_MESSAGE).optional(),
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

  // PRD §4.2: the code is in every SKU of this colour — changing it rebuilds
  // them, and is refused once any of them is on a printed tag.
  const codeChanges = Boolean(parsed.data.code && parsed.data.code !== existing.code);
  if (codeChanges) {
    const clash = await prisma.color.findUnique({ where: { code: parsed.data.code } });
    if (clash) return NextResponse.json({ error: `Code ${parsed.data.code} is already used by ${clash.name}` }, { status: 409 });
    const locked = await countLockedVariants(prisma, { colorId: id });
    if (locked > 0) return NextResponse.json({ error: `Price tags are already printed for ${locked} variant${locked === 1 ? "" : "s"} in this colour — its code is locked.` }, { status: 409 });
  }

  let color;
  let skuChanges: [string, string][] = [];
  try {
    ({ color, skuChanges } = await prisma.$transaction(async (tx) => {
      const updated = await tx.color.update({ where: { id }, data: { ...parsed.data, hexCode: parsed.data.hexCode?.toUpperCase() } });
      return { color: updated, skuChanges: codeChanges ? await regenerateSkus(tx, { colorId: id }) : [] };
    }));
  } catch (error) {
    if (error instanceof SkuError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (isUniqueViolation(error)) return NextResponse.json({ error: RACE_MESSAGE }, { status: 409 });
    throw error;
  }

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.color.update",
    entityType: "color",
    entityId: color.id,
    before: existing,
    after: skuChanges.length > 0 ? { ...color, skuChanges } : color,
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
