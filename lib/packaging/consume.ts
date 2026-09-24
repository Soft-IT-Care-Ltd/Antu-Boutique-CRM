import "server-only";

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { lockVariant, recordStockMovement } from "@/lib/inventory/ledger";
import { materialLabel } from "@/lib/sets/service";

// ============ Packaging used (PRD §4.2 / §4.8 — P3.3) ============
//
// Antu's branded bags, boxes, tissue and tags are COMPONENT_ONLY products:
// stocked and costed like anything else, never sold on their own. What an
// order uses comes from three places, added up per material:
//   - each product's own packaging, per unit sold (a box per saree, a tag
//     per garment) — set components included, so a set never has to repeat
//     its products' own packaging (Gift Valy Products 2)
//   - each set's packaging, per set sold (the set's gift box)
//   - the order-level default: per online parcel (a mailer bag) or per
//     showroom sale (a shopping bag)
// It leaves stock when the order is packed (online) or sold (POS, counter
// exchange), as PACKAGING_OUT ledger rows in the same transaction (rule 2),
// and its cost posts ONCE per order as a "Packaging used" expense under the
// Packaging heading (expenses.packagingOrderId is unique). Packaging is used
// up: cancelling or returning the order never puts it back. Running short
// never blocks packing — stock goes negative and shows as a shortage.

export const PACKAGING_USED_CATEGORY_ID = "expcat_packaging_used";

export type PackagingScopeValue = "ONLINE_PARCEL" | "POS_SALE";

export type PackagingNeed = { materialVariantId: string; sku: string; label: string; qty: number; available: number };

export async function packagingForOrder(db: Db | Prisma.TransactionClient, orderId: string, scope: PackagingScopeValue): Promise<PackagingNeed[]> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { items: { select: { qty: true, variant: { select: { productId: true } } } }, setLines: { select: { outfitSetId: true, qty: true } } },
  });
  const productQty = new Map<string, number>();
  for (const i of order.items) productQty.set(i.variant.productId, (productQty.get(i.variant.productId) ?? 0) + i.qty);
  const setQty = new Map<string, number>();
  for (const s of order.setLines) setQty.set(s.outfitSetId, (setQty.get(s.outfitSetId) ?? 0) + s.qty);

  const rules = await db.packagingComponent.findMany({
    where: { OR: [{ productId: { in: [...productQty.keys()] } }, { outfitSetId: { in: [...setQty.keys()] } }, { scope }] },
    include: { materialVariant: { select: { id: true, sku: true, stockQty: true, reservedQty: true, product: { select: { name: true, deletedAt: true } }, size: { select: { name: true } }, color: { select: { name: true } } } } },
  });
  const need = new Map<string, PackagingNeed>();
  for (const r of rules) {
    if (r.materialVariant.product.deletedAt) continue;
    const times = r.productId ? (productQty.get(r.productId) ?? 0) : r.outfitSetId ? (setQty.get(r.outfitSetId) ?? 0) : 1;
    if (times <= 0) continue;
    const existing = need.get(r.materialVariantId);
    if (existing) existing.qty += r.qty * times;
    else need.set(r.materialVariantId, { materialVariantId: r.materialVariantId, sku: r.materialVariant.sku, label: materialLabel(r.materialVariant), qty: r.qty * times, available: r.materialVariant.stockQty - r.materialVariant.reservedQty });
  }
  return [...need.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Takes the order's packaging out of stock and posts its cost once. Safe to
 * call twice: an order that already posted its packaging is left alone.
 */
export async function consumePackaging(
  tx: Prisma.TransactionClient,
  input: { orderId: string; orderNo: string; scope: PackagingScopeValue; actorId: string | null },
): Promise<{ lines: PackagingNeed[]; costPaisa: number }> {
  const already = await tx.stockMovement.count({ where: { type: "PACKAGING_OUT", referenceType: "ORDER", referenceId: input.orderId } });
  if (already > 0) return { lines: [], costPaisa: 0 };

  const lines = await packagingForOrder(tx, input.orderId, input.scope);
  let costPaisa = 0;
  // Locked in id order, like every multi-variant stock write.
  for (const line of [...lines].sort((a, b) => a.materialVariantId.localeCompare(b.materialVariantId))) {
    const locked = await lockVariant(tx, line.materialVariantId);
    if (!locked) continue;
    await recordStockMovement(tx, {
      variantId: line.materialVariantId,
      type: "PACKAGING_OUT",
      qty: -line.qty,
      unitCost: locked.weightedAvgCost,
      referenceType: "ORDER",
      referenceId: input.orderId,
      actorId: input.actorId,
      note: `Packaging for ${input.orderNo}`,
    });
    costPaisa += toPaisa(locked.weightedAvgCost) * line.qty;
  }
  if (costPaisa > 0) {
    await tx.expense.create({
      data: {
        expenseDate: new Date(),
        categoryId: PACKAGING_USED_CATEGORY_ID,
        nature: "VARIABLE",
        amount: fromPaisa(costPaisa),
        note: `Packaging for ${input.orderNo}: ${lines.map((l) => `${l.qty} × ${l.label}`).join(", ")}`,
        packagingOrderId: input.orderId,
        createdById: input.actorId,
      },
    });
  }
  return { lines, costPaisa };
}

/** What the packing screen and slip show: the packaging used, once the order is packed; what it will take, before. */
export async function packagingForDisplay(db: Db | Prisma.TransactionClient, orderId: string, scope: PackagingScopeValue): Promise<PackagingNeed[]> {
  const used = await db.stockMovement.findMany({
    where: { type: "PACKAGING_OUT", referenceType: "ORDER", referenceId: orderId },
    select: { qty: true, variant: { select: { id: true, sku: true, stockQty: true, reservedQty: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } } },
  });
  if (used.length === 0) return packagingForOrder(db, orderId, scope);
  return used
    .map((m) => ({ materialVariantId: m.variant.id, sku: m.variant.sku, label: materialLabel(m.variant), qty: -m.qty, available: m.variant.stockQty - m.variant.reservedQty }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
