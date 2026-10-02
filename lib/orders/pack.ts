import "server-only";

import type { Prisma } from "@prisma/client";

import { IllegalTransitionError, moveOrderStatus } from "@/lib/orders/lifecycle";
import { computeAllocation } from "@/lib/fulfilment/allocation";
import { lockVariantAt } from "@/lib/inventory/ledger";
import { describeElsewhere, getPackingHub, stockByLocation } from "@/lib/locations/service";
import { deductVariantStockAtPack } from "@/lib/orders/stock";
import { isTransitionAllowed } from "@/lib/orders/status-graph";
import { consumePackaging } from "@/lib/packaging/consume";
import type { OrderStatusValue } from "@/lib/orders/constants";

export { IllegalTransitionError };

/** The packing hub doesn't hold every unit (C3 — CORRECTIONS.md "Changes to existing rules" 8). */
export class PackStockError extends Error {}

// PRD §4.8 packing checklist — required before PACKED. Every key must be
// `true`; the API route's Zod schema enforces this server-side (CLAUDE.md
// rule 9 — the client's checklist UI is a convenience, not the guarantee).
export const PACKING_CHECKLIST_KEYS = ["itemsMatch", "imageMatched", "qualityChecked", "invoicePrinted"] as const;
export type PackingChecklistKey = (typeof PACKING_CHECKLIST_KEYS)[number];
export type PackingChecklist = Record<PackingChecklistKey, boolean>;

type OrderForPacking = {
  id: string;
  status: OrderStatusValue;
  items: { id: string; variantId: string; qty: number }[];
};

/**
 * The one place an order reaches PACKED (PRD §4.8, CLAUDE.md rule 2 + 3 +
 * 10). For every line: freezes unit_cost_snapshot from the variant's
 * CURRENT weighted average cost (never touched again — rule 3) and deducts
 * real stock with a SALE_OUT ledger row (EXCHANGE_OUT for an exchange's
 * replacement) at that same cost (rules 2 + 10), takes its packaging out
 * of stock (P3.3), then moves the order to PACKED via the same
 * status-history writer every other transition uses. All of it — item
 * updates, stock deduction, status move — runs in the caller's transaction,
 * so a failure anywhere rolls the whole pack back (rule 2).
 */
export async function packOrder(
  tx: Prisma.TransactionClient,
  order: OrderForPacking,
  packerId: string,
  note?: string | null,
): Promise<void> {
  if (!isTransitionAllowed(order.status, "PACKED")) {
    throw new IllegalTransitionError(order.status, "PACKED");
  }

  const { exchangedFromOrderId, orderNo } = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { exchangedFromOrderId: true, orderNo: true } });

  // C3: packing needs every unit AT THE HUB — stock elsewhere must be
  // transferred in first (C4). Locked in id order before anything is
  // written, so the check and the deduction see the same figures.
  const hub = await getPackingHub(tx);
  const need = new Map<string, number>();
  for (const item of order.items) need.set(item.variantId, (need.get(item.variantId) ?? 0) + item.qty);
  const variantIds = [...need.keys()].sort();
  const short: string[] = [];
  for (const variantId of variantIds) {
    const locked = await lockVariantAt(tx, variantId, hub.id);
    if (!locked) throw new PackStockError("One of the items is no longer in the catalog.");
    if (locked.locationQty < need.get(variantId)!) short.push(variantId);
  }
  if (short.length > 0) {
    const [skus, elsewhere] = await Promise.all([
      tx.productVariant.findMany({ where: { id: { in: short } }, select: { id: true, sku: true } }),
      stockByLocation(tx, short),
    ]);
    const lines = skus.map((v) => {
      const atHub = elsewhere.get(v.id)?.find((s) => s.locationId === hub.id)?.qty ?? 0;
      return `${v.sku}: ${Math.max(0, atHub)} of ${need.get(v.id)} at ${hub.name} (${describeElsewhere(elsewhere.get(v.id), hub.id)})`;
    });
    throw new PackStockError(`Not everything is at ${hub.name} yet — ${lines.join("; ")}. Transfer it to the packing hub first.`);
  }

  // C5 — the hub holds enough, but older orders come first (CORRECTIONS.md
  // item 13): the same allocation that sets every order's fulfilment status
  // decides, under the variant locks just taken, whether this order's units
  // are its own. Packing a newer order must never take an older one's piece.
  const allocation = await computeAllocation(tx, variantIds);
  const notMine = allocation.lines.filter((l) => l.orderId === order.id && l.atHub < l.qty);
  if (notMine.length > 0) {
    const shortVariants = new Set(notMine.map((l) => l.variantId));
    const placedAt = allocation.orders.find((o) => o.id === order.id)?.createdAt ?? new Date();
    const olderIds = new Set(allocation.lines.filter((l) => l.orderId !== order.id && shortVariants.has(l.variantId) && l.atHub > 0).map((l) => l.orderId));
    const older = allocation.orders.filter((o) => olderIds.has(o.id) && o.createdAt <= placedAt).map((o) => o.orderNo);
    const skus = (await tx.productVariant.findMany({ where: { id: { in: [...shortVariants] } }, select: { sku: true } })).map((v) => v.sku).join(", ");
    throw new PackStockError(
      older.length > 0
        ? `${older.join(", ")} ${older.length === 1 ? "was" : "were"} placed earlier and ${older.length === 1 ? "is" : "are"} counting on the same piece at ${hub.name} (${skus}) — older orders are packed first. This order isn't ready to pack yet.`
        : `This order isn't ready to pack: ${skus} at ${hub.name} is already counted for other orders.`,
    );
  }

  for (const item of order.items) {
    const variant = await tx.productVariant.findUniqueOrThrow({
      where: { id: item.variantId },
      select: { weightedAvgCost: true },
    });
    await tx.orderItem.update({
      where: { id: item.id },
      data: { unitCostSnapshot: variant.weightedAvgCost },
    });
    await deductVariantStockAtPack(tx, {
      orderId: order.id,
      variantId: item.variantId,
      locationId: hub.id,
      qty: item.qty,
      unitCost: variant.weightedAvgCost,
      actorId: packerId,
      isExchange: exchangedFromOrderId !== null,
    });
  }

  // P3.3 — the bags, boxes, tissue and tags this parcel uses leave stock
  // now too, and their cost posts once (lib/packaging/consume.ts).
  await consumePackaging(tx, { orderId: order.id, orderNo, scope: "ONLINE_PARCEL", locationId: hub.id, actorId: packerId });

  await moveOrderStatus(
    tx,
    { id: order.id, status: order.status, items: order.items.map((i) => ({ variantId: i.variantId, qty: i.qty, unitCostSnapshot: null })) },
    "PACKED",
    packerId,
    note,
  );
}
