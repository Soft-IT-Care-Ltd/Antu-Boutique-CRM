import type { Prisma, ReturnInspectionSource } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { COURIER_RETURN_CHARGE_EXPENSE_CATEGORY } from "@/lib/courier/constants";
import { writeOffDamagedStock } from "@/lib/inventory/adjustments";
import { recordStockMovement } from "@/lib/inventory/ledger";
import { toNumber } from "@/lib/money";

// ============ Packing condition check for goods coming back (PRD §4.9 / §4.11) ============
//
// The ONE service that puts returned goods back into stock. Courier returns
// (RETURNED), partial deliveries (the items the customer didn't keep) and —
// Phase 3 — exchanges all open a return_inspections row and complete it
// here. Per unit, the inspector decides:
//   Good    → RETURN_IN (EXCHANGE_IN for an exchange): back on the shelf
//   Damaged → RETURN_IN then DAMAGE_OUT + an expense at cost: the unit came
//             back into our hands and was written off, and the ledger says so
// Both are valued at the line's frozen unit_cost_snapshot (CLAUDE.md rule
// 3), so what comes back is worth exactly what went out. A courier return
// also posts the courier's return charge as an expense, once.
//
// Deliberately free of "server-only" and of the prisma singleton — it acts
// only through the `tx` it is handed (same convention as lib/inventory/ledger.ts).

export class ConditionCheckError extends Error {}

/**
 * Opens the condition-check task for an order whose goods are coming back.
 * Idempotent: an existing open inspection of the same source is returned
 * as-is, so a replayed courier webhook can never open a second one. Only
 * packed lines (unit_cost_snapshot set) are expected back; returns null
 * when there is nothing to check.
 */
export async function openReturnInspection(
  tx: Prisma.TransactionClient,
  input: { orderId: string; source: ReturnInspectionSource },
): Promise<{ id: string } | null> {
  const existing = await tx.returnInspection.findFirst({
    where: { orderId: input.orderId, source: input.source, status: { not: "COMPLETED" } },
    select: { id: true },
  });
  if (existing) return existing;

  const order = await tx.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: {
      shipment: { select: { id: true } },
      items: { select: { id: true, qty: true, returnedQty: true, unitCostSnapshot: true } },
    },
  });
  const packedLines = order.items.filter((i) => i.unitCostSnapshot !== null);
  if (packedLines.length === 0) return null;

  // A partial delivery can't list lines yet: staff first mark which items
  // the customer kept (lib/courier/partial-delivery.ts fills them in).
  if (input.source === "PARTIAL_DELIVERY") {
    return tx.returnInspection.create({
      data: { orderId: input.orderId, shipmentId: order.shipment?.id ?? null, source: input.source, status: "AWAITING_KEPT_ITEMS" },
      select: { id: true },
    });
  }

  // Full return: everything the customer still had comes back. (After a
  // partial delivery, returnedQty units already came back through their own
  // check, so only the kept units are expected here.)
  const lines = packedLines.map((i) => ({ orderItemId: i.id, qty: i.qty - i.returnedQty })).filter((l) => l.qty > 0);
  if (lines.length === 0) return null;

  return tx.returnInspection.create({
    data: {
      orderId: input.orderId,
      shipmentId: order.shipment?.id ?? null,
      source: input.source,
      status: "PENDING",
      lines: { create: lines },
    },
    select: { id: true },
  });
}

export type ConditionCheckLineInput = { orderItemId: string; goodQty: number; damagedQty: number };

export type ConditionCheckResult = {
  restockedUnits: number;
  writtenOffUnits: number;
  /** Null when no return charge applied (not a courier return, or no charge known). */
  returnChargePosted: string | null;
};

/** Completes a PENDING inspection: every expected unit must be marked Good or Damaged. */
export async function completeConditionCheck(
  tx: Prisma.TransactionClient,
  input: { inspectionId: string; lines: ConditionCheckLineInput[]; note?: string | null },
  actorId: string | null,
): Promise<ConditionCheckResult> {
  const inspection = await tx.returnInspection.findUnique({
    where: { id: input.inspectionId },
    include: {
      lines: { include: { orderItem: { select: { id: true, variantId: true, unitCostSnapshot: true, variant: { select: { sku: true } } } } } },
      order: { select: { id: true, orderNo: true, courierId: true, courierZone: { select: { zone: true } } } },
      shipment: { select: { courierId: true, zone: true, courierCostActual: true } },
    },
  });
  if (!inspection) throw new ConditionCheckError("Return inspection not found");
  if (inspection.status !== "PENDING") {
    throw new ConditionCheckError(
      inspection.status === "COMPLETED" ? "This return has already been checked" : "Mark which items the customer kept first",
    );
  }

  const byItem = new Map(input.lines.map((l) => [l.orderItemId, l]));
  if (byItem.size !== input.lines.length) throw new ConditionCheckError("Each item may only appear once");
  for (const line of input.lines) {
    if (!inspection.lines.some((l) => l.orderItemId === line.orderItemId)) throw new ConditionCheckError("That item is not part of this return");
  }
  for (const line of inspection.lines) {
    const entry = byItem.get(line.orderItemId);
    const good = entry?.goodQty ?? 0;
    const damaged = entry?.damagedQty ?? 0;
    if (!Number.isInteger(good) || !Number.isInteger(damaged) || good < 0 || damaged < 0 || good + damaged !== line.qty) {
      throw new ConditionCheckError(`${line.orderItem.variant.sku}: mark all ${line.qty} unit(s) as Good or Damaged`);
    }
  }

  // Claim the inspection before touching stock, so two inspectors
  // submitting at once can't both restock it.
  const now = new Date();
  const claimed = await tx.returnInspection.updateMany({
    where: { id: inspection.id, status: "PENDING" },
    data: { status: "COMPLETED", inspectedAt: now, inspectedById: actorId, note: input.note?.trim() || null },
  });
  if (claimed.count !== 1) throw new ConditionCheckError("This return has already been checked");

  const isExchange = inspection.source === "EXCHANGE";
  const restockType = isExchange ? "EXCHANGE_IN" : "RETURN_IN";
  const referenceType = isExchange ? "EXCHANGE" : "RETURN";
  let restockedUnits = 0;
  let writtenOffUnits = 0;

  for (const line of inspection.lines) {
    const { goodQty, damagedQty } = byItem.get(line.orderItemId)!;
    await tx.returnInspectionLine.update({ where: { id: line.id }, data: { goodQty, damagedQty } });

    const item = line.orderItem;
    const unitCost =
      item.unitCostSnapshot ??
      (await tx.productVariant.findUniqueOrThrow({ where: { id: item.variantId }, select: { weightedAvgCost: true } })).weightedAvgCost;

    if (goodQty > 0) {
      await recordStockMovement(tx, {
        variantId: item.variantId,
        type: restockType,
        qty: goodQty,
        unitCost,
        referenceType,
        referenceId: inspection.id,
        actorId,
        note: `${inspection.order.orderNo} — returned in good condition`,
      });
      restockedUnits += goodQty;
    }
    if (damagedQty > 0) {
      await recordStockMovement(tx, {
        variantId: item.variantId,
        type: restockType,
        qty: damagedQty,
        unitCost,
        referenceType,
        referenceId: inspection.id,
        actorId,
        note: `${inspection.order.orderNo} — returned damaged (written off below)`,
      });
      await writeOffDamagedStock(
        tx,
        { variantId: item.variantId, qty: damagedQty, reason: `${inspection.order.orderNo} — damaged on return` },
        actorId,
        { unitCost, referenceType, referenceId: inspection.id },
      );
      writtenOffUnits += damagedQty;
    }
  }

  const returnChargePosted = inspection.source === "COURIER_RETURN" ? await postCourierReturnCharge(tx, inspection, actorId) : null;

  await writeAuditLogWith(tx, {
    actorId,
    action: "return.condition_check",
    entityType: "order",
    entityId: inspection.order.id,
    after: {
      inspectionId: inspection.id,
      source: inspection.source,
      lines: input.lines,
      note: input.note ?? null,
      restockedUnits,
      writtenOffUnits,
      returnChargePosted,
    },
  });

  return { restockedUnits, writtenOffUnits, returnChargePosted };
}

/**
 * PRD §4.9: the courier's return charge lands in expenses so the loss on a
 * returned parcel shows in P&L. Amount: the courier's own charge for this
 * consignment when it reported one (webhook delivery_charge on the
 * cancelled parcel), else the configured return charge for the order's
 * courier + zone. Posted at most once per inspection (unique FK).
 */
async function postCourierReturnCharge(
  tx: Prisma.TransactionClient,
  inspection: {
    id: string;
    order: { orderNo: string; courierId: string | null; courierZone: { zone: string } | null };
    shipment: { courierId: string; zone: string | null; courierCostActual: Prisma.Decimal | null } | null;
  },
  actorId: string | null,
): Promise<string | null> {
  let amount: Prisma.Decimal | null = inspection.shipment?.courierCostActual ?? null;
  if (amount === null) {
    const courierId = inspection.shipment?.courierId ?? inspection.order.courierId;
    const zone = inspection.shipment?.zone ?? inspection.order.courierZone?.zone ?? null;
    if (courierId && zone) {
      const configured = await tx.courierZone.findUnique({
        where: { courierId_zone: { courierId, zone: zone as "INSIDE_CITY" | "SUB_CITY" | "OUTSIDE_CITY" } },
        select: { returnCharge: true },
      });
      amount = configured?.returnCharge ?? null;
    }
  }
  if (amount === null || toNumber(amount) <= 0) return null;

  const category = await tx.expenseCategory.upsert({
    where: { name: COURIER_RETURN_CHARGE_EXPENSE_CATEGORY },
    update: {},
    create: { name: COURIER_RETURN_CHARGE_EXPENSE_CATEGORY, sortOrder: 12, kind: "COURIER", isSystem: true },
  });
  await tx.expense.create({
    data: {
      expenseDate: new Date(),
      categoryId: category.id,
      nature: "VARIABLE",
      amount,
      note: `Courier return charge — ${inspection.order.orderNo}`,
      returnChargeInspectionId: inspection.id,
      createdById: actorId,
    },
  });
  return amount.toString();
}
