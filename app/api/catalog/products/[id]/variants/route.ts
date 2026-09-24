import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { SKU_PATTERN, SKU_PATTERN_MESSAGE } from "@/lib/barcode/scan";
import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const variants = await prisma.productVariant.findMany({
    where: { productId: id },
    include: { size: true, color: true },
    orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
  });

  const body = {
    variants: variants.map((v) => ({
      ...v,
      weightedAvgCost: v.weightedAvgCost.toString(),
      priceOverride: v.priceOverride?.toString() ?? null,
      available: v.stockQty - v.reservedQty,
    })),
  };

  return NextResponse.json(await stripCostFieldsForUser(body, guard.user));
}

// PRD §4.2 variant matrix grid: editable columns are SKU (once), price
// override, low-stock threshold, weight (P2.2) and active flag. Stock/cost are read-only
// here — they only move through stock_movements (Phase 2), per CLAUDE.md
// rule 2 and the P1.1 build prompt.
const editSchema = z.object({
  variantId: z.string().cuid(),
  // P3.1 — a SKU is what its price tag's barcode carries and what the POS
  // scan box reads back: up to 9 capital letters/digits (lib/barcode/scan.ts).
  sku: z.string().trim().toUpperCase().regex(SKU_PATTERN, SKU_PATTERN_MESSAGE).optional(),
  priceOverride: z.union([z.coerce.number().nonnegative(), z.null()]).optional(),
  lowStockThreshold: z.union([z.coerce.number().int().min(0), z.null()]).optional(),
  // P2.2 — optional parcel weight per unit (grams), for courier cost estimates.
  weightGrams: z.union([z.coerce.number().int().min(1).max(50_000), z.null()]).optional(),
  isActive: z.boolean().optional(),
});

const bulkSchema = z.object({ edits: z.array(editSchema).min(1).max(200) });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.edit");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const variantIds = parsed.data.edits.map((e) => e.variantId);
  const existing = await prisma.productVariant.findMany({ where: { id: { in: variantIds }, productId: id } });
  const existingById = new Map(existing.map((v) => [v.id, v]));

  for (const edit of parsed.data.edits) {
    if (!existingById.has(edit.variantId)) {
      return NextResponse.json({ error: `Variant ${edit.variantId} not found on this product` }, { status: 404 });
    }
  }

  for (const edit of parsed.data.edits) {
    const current = existingById.get(edit.variantId)!;
    // PRD §4.2: a SKU can be edited until its first price tag is printed —
    // after that the tag carries it (a DB trigger refuses the change too).
    if (edit.sku !== undefined && edit.sku !== current.sku && current.tagPrintedAt) {
      return NextResponse.json(
        { error: `A price tag has already been printed for ${current.sku} — its SKU is locked` },
        { status: 409 },
      );
    }
  }

  if (parsed.data.edits.some((e) => e.sku)) {
    const requestedSkus = parsed.data.edits.filter((e) => e.sku).map((e) => e.sku!);
    const clashes = await prisma.productVariant.findMany({
      where: { sku: { in: requestedSkus }, id: { notIn: variantIds } },
      select: { sku: true },
    });
    if (clashes.length > 0) {
      return NextResponse.json({ error: `SKU already in use: ${clashes[0].sku}` }, { status: 409 });
    }
  }

  const updated = await prisma.$transaction(
    parsed.data.edits.map((edit) => {
      const current = existingById.get(edit.variantId)!;
      const data: Record<string, unknown> = {};
      if (edit.sku !== undefined && edit.sku !== current.sku) data.sku = edit.sku;
      if (edit.priceOverride !== undefined) data.priceOverride = edit.priceOverride;
      if (edit.lowStockThreshold !== undefined) data.lowStockThreshold = edit.lowStockThreshold;
      if (edit.weightGrams !== undefined) data.weightGrams = edit.weightGrams;
      if (edit.isActive !== undefined) data.isActive = edit.isActive;

      return prisma.productVariant.update({
        where: { id: edit.variantId },
        data,
        include: { size: true, color: true },
      });
    }),
  );

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.variant.bulk_update",
    entityType: "product",
    entityId: id,
    before: existing.map((v) => ({ id: v.id, sku: v.sku, priceOverride: v.priceOverride?.toString(), lowStockThreshold: v.lowStockThreshold, weightGrams: v.weightGrams, isActive: v.isActive })),
    after: updated.map((v) => ({ id: v.id, sku: v.sku, priceOverride: v.priceOverride?.toString(), lowStockThreshold: v.lowStockThreshold, weightGrams: v.weightGrams, isActive: v.isActive })),
    request,
  });

  const body = {
    variants: updated.map((v) => ({
      ...v,
      weightedAvgCost: v.weightedAvgCost.toString(),
      priceOverride: v.priceOverride?.toString() ?? null,
      available: v.stockQty - v.reservedQty,
    })),
  };

  return NextResponse.json(await stripCostFieldsForUser(body, guard.user));
}
