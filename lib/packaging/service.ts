import "server-only";

import { writeAuditLogWith } from "@/lib/audit/log";
import { withTx, type Db } from "@/lib/db/tx";
import { materialLabel, SetError, toPackagingLine, validatePackaging } from "@/lib/sets/service";
import type { PackagingLine } from "@/lib/sets/types";
import type { PackagingScopeValue } from "@/lib/packaging/consume";

// P3.3 — packaging materials (COMPONENT_ONLY products) and where they're
// used: per unit of a product, per set (lib/sets/service.ts), and per online
// parcel / showroom sale. Consumption is lib/packaging/consume.ts.

export type PackagingMaterial = { variantId: string; productId: string; label: string; sku: string; available: number; weightedAvgCost?: string };

export async function listPackagingMaterials(db: Db): Promise<PackagingMaterial[]> {
  const variants = await db.productVariant.findMany({
    where: { isActive: true, product: { kind: "COMPONENT_ONLY", deletedAt: null } },
    orderBy: [{ product: { name: "asc" } }, { sku: "asc" }],
    select: { id: true, productId: true, sku: true, stockQty: true, reservedQty: true, weightedAvgCost: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } },
  });
  return variants.map((v) => ({ variantId: v.id, productId: v.productId, label: materialLabel(v), sku: v.sku, available: v.stockQty - v.reservedQty, weightedAvgCost: v.weightedAvgCost.toFixed(2) }));
}

const LINE_INCLUDE = {
  materialVariant: { select: { id: true, sku: true, stockQty: true, reservedQty: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } },
} as const;

export async function getPackagingDefaults(db: Db): Promise<Record<PackagingScopeValue, PackagingLine[]>> {
  const rows = await db.packagingComponent.findMany({ where: { scope: { not: null } }, orderBy: { createdAt: "asc" }, include: LINE_INCLUDE });
  return {
    ONLINE_PARCEL: rows.filter((r) => r.scope === "ONLINE_PARCEL").map(toPackagingLine),
    POS_SALE: rows.filter((r) => r.scope === "POS_SALE").map(toPackagingLine),
  };
}

export async function getProductPackaging(db: Db, productId: string): Promise<PackagingLine[]> {
  const rows = await db.packagingComponent.findMany({ where: { productId }, orderBy: { createdAt: "asc" }, include: LINE_INCLUDE });
  return rows.map(toPackagingLine);
}

type Lines = { materialVariantId: string; qty: number }[];

/** Replaces what one owner uses — a product, or every parcel / counter sale. Audited. */
export async function setPackaging(db: Db, actorId: string, owner: { productId: string } | { scope: PackagingScopeValue }, lines: Lines, request?: Request): Promise<void> {
  await withTx(db, async (tx) => {
    await validatePackaging(tx, lines);
    const where = "productId" in owner ? { productId: owner.productId } : { scope: owner.scope };
    if ("productId" in owner) {
      const product = await tx.product.findFirst({ where: { id: owner.productId, deletedAt: null }, select: { kind: true, name: true } });
      if (!product) throw new SetError("Product not found", 404);
      if (product.kind !== "SELLABLE") throw new SetError(`${product.name} is packaging material itself — it can't have packaging.`);
    }
    const before = await tx.packagingComponent.findMany({ where, select: { materialVariantId: true, qty: true } });
    await tx.packagingComponent.deleteMany({ where });
    if (lines.length > 0) await tx.packagingComponent.createMany({ data: lines.map((l) => ({ ...where, materialVariantId: l.materialVariantId, qty: l.qty })) });
    await writeAuditLogWith(tx, {
      actorId,
      action: "catalog.packaging.update",
      entityType: "productId" in owner ? "product" : "setting",
      entityId: "productId" in owner ? owner.productId : `packaging_${owner.scope.toLowerCase()}`,
      before: { packaging: before },
      after: { packaging: lines },
      request,
    });
  });
}
