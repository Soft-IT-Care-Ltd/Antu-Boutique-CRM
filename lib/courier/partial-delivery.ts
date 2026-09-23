import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { toNumber } from "@/lib/money";
import { computeOrderTotals, recomputeOrderDueAmount } from "@/lib/orders/totals";

// ============ Partial delivery (P2.2) ============
//
// Boutique customers often keep one of two items and send the other back
// with the rider. When the courier reports partial_delivered the order goes
// to PARTIAL_DELIVERED, its shipment is flagged for ACCOUNTS, and a
// return inspection waits in AWAITING_KEPT_ITEMS. Here staff record what the
// customer kept:
//   - order_items.returnedQty = qty − kept (qty itself is never rewritten)
//   - the order total is recomputed on the kept quantities (line discount
//     pro-rated), and due_amount recomputed from it (CLAUDE.md rule 1) —
//     so the order stops showing money that will never be collected
//   - the returned units become inspection lines for the Packing condition
//     check (lib/returns/condition-check.ts)

export class PartialDeliveryError extends Error {}

export type KeptItemInput = { orderItemId: string; keptQty: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function markKeptItems(
  tx: Prisma.TransactionClient,
  input: { inspectionId: string; kept: KeptItemInput[] },
  actorId: string,
): Promise<{ returnedUnits: number; total: number; dueAmount: number }> {
  const inspection = await tx.returnInspection.findUnique({
    where: { id: input.inspectionId },
    include: {
      order: {
        include: { items: { select: { id: true, qty: true, unitPrice: true, lineDiscount: true, unitCostSnapshot: true, returnedQty: true } } },
      },
    },
  });
  if (!inspection || inspection.source !== "PARTIAL_DELIVERY") throw new PartialDeliveryError("Partial delivery not found");
  if (inspection.status !== "AWAITING_KEPT_ITEMS") throw new PartialDeliveryError("Kept items have already been recorded for this delivery");

  const order = inspection.order;
  const packed = order.items.filter((i) => i.unitCostSnapshot !== null);
  const keptById = new Map(input.kept.map((k) => [k.orderItemId, k.keptQty]));
  if (keptById.size !== input.kept.length) throw new PartialDeliveryError("Each item may only appear once");
  for (const k of input.kept) {
    if (!packed.some((i) => i.id === k.orderItemId)) throw new PartialDeliveryError("That item is not part of this order");
  }
  for (const item of packed) {
    const kept = keptById.get(item.id);
    if (kept === undefined || !Number.isInteger(kept) || kept < 0 || kept > item.qty) {
      throw new PartialDeliveryError(`Enter how many of each item the customer kept (0–${item.qty})`);
    }
  }

  // Claim before writing, so a double submit can't apply twice.
  const claimed = await tx.returnInspection.updateMany({
    where: { id: inspection.id, status: "AWAITING_KEPT_ITEMS" },
    data: { status: "PENDING", keptItemsMarkedAt: new Date(), keptItemsMarkedById: actorId },
  });
  if (claimed.count !== 1) throw new PartialDeliveryError("Kept items have already been recorded for this delivery");

  const before = { subtotal: order.subtotal.toString(), discountTotal: order.discountTotal.toString(), total: order.total.toString(), dueAmount: order.dueAmount.toString() };

  let returnedUnits = 0;
  for (const item of packed) {
    const returnedQty = item.qty - keptById.get(item.id)!;
    returnedUnits += returnedQty;
    await tx.orderItem.update({ where: { id: item.id }, data: { returnedQty } });
    if (returnedQty > 0) {
      await tx.returnInspectionLine.create({ data: { inspectionId: inspection.id, orderItemId: item.id, qty: returnedQty } });
    }
  }
  // Nothing came back → nothing for Packing to check.
  if (returnedUnits === 0) {
    await tx.returnInspection.update({ where: { id: inspection.id }, data: { status: "COMPLETED", inspectedAt: new Date(), note: "Customer kept every item" } });
  }

  const lines = order.items.map((item) => {
    const kept = item.unitCostSnapshot === null ? item.qty : keptById.get(item.id)!;
    const lineDiscount = item.qty === 0 ? 0 : round2((toNumber(item.lineDiscount) * kept) / item.qty);
    return { qty: kept, unitPrice: toNumber(item.unitPrice), lineDiscount };
  });
  const totals = computeOrderTotals(lines, toNumber(order.deliveryCharge));
  await tx.order.update({
    where: { id: order.id },
    data: { subtotal: round2(totals.subtotal), discountTotal: round2(totals.discountTotal), total: round2(totals.total) },
  });
  const dueAmount = await recomputeOrderDueAmount(tx, order.id);

  await writeAuditLogWith(tx, {
    actorId,
    action: "order.partial_delivery.kept_items",
    entityType: "order",
    entityId: order.id,
    before,
    after: { kept: input.kept, returnedUnits, subtotal: round2(totals.subtotal), discountTotal: round2(totals.discountTotal), total: round2(totals.total), dueAmount },
  });

  return { returnedUnits, total: round2(totals.total), dueAmount };
}

/** ACCOUNTS clears the partial-delivery money flag once they've reconciled it. */
export async function markAccountsReviewed(tx: Prisma.TransactionClient, shipmentId: string, actorId: string, note?: string | null): Promise<void> {
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, orderId: true, accountsReviewRequired: true } });
  if (!shipment) throw new PartialDeliveryError("Shipment not found");
  if (!shipment.accountsReviewRequired) throw new PartialDeliveryError("This shipment isn't waiting for an Accounts review");
  await tx.shipment.update({
    where: { id: shipmentId },
    data: { accountsReviewRequired: false, accountsReviewedAt: new Date(), accountsReviewedById: actorId },
  });
  await writeAuditLogWith(tx, {
    actorId,
    action: "shipment.accounts_review",
    entityType: "order",
    entityId: shipment.orderId,
    after: { shipmentId, note: note ?? null },
  });
}
