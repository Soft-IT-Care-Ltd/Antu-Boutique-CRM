import "server-only";

import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { toNumber } from "@/lib/money";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { releaseVariantStock, reserveVariantStock } from "@/lib/orders/stock";
import { computeDueAmount, computeOrderTotals, COUNTED_PAYMENTS_WHERE } from "@/lib/orders/totals";

// Shared by the direct in-window PATCH (app/api/orders/[id]/route.ts) and
// the TL/Admin edit-request approval (app/api/order-edit-requests/[id]/
// route.ts) — both end up applying the exact same kind of change to an
// order, and both need to re-validate against *current* stock/price-floor
// state right before writing (an edit request can sit PENDING long enough
// for either to have moved).

export type OrderEditItemInput = {
  variantId: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  stockOverrideReason?: string;
};

export type OrderEditInput = {
  items?: OrderEditItemInput[];
  courierId?: string | null;
  courierZoneId?: string | null;
  deliveryCharge?: number;
  expectedDeliveryDate?: Date | null;
  internalNote?: string | null;
  deliveryNote?: string | null;
};

type ValidatedItem = OrderEditItemInput;

export type OrderEditValidation =
  | {
      ok: true;
      validatedItems: ValidatedItem[] | null;
      effectiveDeliveryCharge: number;
      subtotal: number;
      discountTotal: number;
      total: number;
      dueAmount: number;
    }
  | { ok: false; error: string; status: number };

// The Prisma `Json` column round-trips a Date as an ISO string (Date has a
// toJSON()), so an OrderEditRequest.proposedChanges read back from the DB
// needs expectedDeliveryDate rehydrated before it's usable as OrderEditInput.
export function parseStoredOrderEditInput(raw: unknown): OrderEditInput {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawDate = obj.expectedDeliveryDate;
  return {
    items: Array.isArray(obj.items) ? (obj.items as OrderEditItemInput[]) : undefined,
    courierId: obj.courierId === undefined ? undefined : (obj.courierId as string | null),
    courierZoneId: obj.courierZoneId === undefined ? undefined : (obj.courierZoneId as string | null),
    deliveryCharge: typeof obj.deliveryCharge === "number" ? obj.deliveryCharge : undefined,
    expectedDeliveryDate: rawDate === undefined ? undefined : rawDate === null ? null : new Date(rawDate as string),
    internalNote: obj.internalNote === undefined ? undefined : (obj.internalNote as string | null),
    deliveryNote: obj.deliveryNote === undefined ? undefined : (obj.deliveryNote as string | null),
  };
}

/** Re-runs every business-rule check the order PATCH route enforces, against the order's CURRENT state. No writes. */
export async function validateOrderEdit(orderId: string, input: OrderEditInput, actor: SessionUser): Promise<OrderEditValidation> {
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: { where: COUNTED_PAYMENTS_WHERE, select: { amount: true } } },
  });
  if (!existing) return { ok: false, error: "Order not found", status: 404 };

  if (input.courierZoneId) {
    const zone = await prisma.courierZone.findUnique({ where: { id: input.courierZoneId } });
    if (!zone || (input.courierId && zone.courierId !== input.courierId)) {
      return { ok: false, error: "Selected delivery zone does not belong to the selected courier", status: 400 };
    }
  }

  const oldQtyByVariant = new Map<string, number>();
  for (const item of existing.items) {
    oldQtyByVariant.set(item.variantId, (oldQtyByVariant.get(item.variantId) ?? 0) + item.qty);
  }

  let validatedItems: ValidatedItem[] | null = null;

  if (input.items) {
    const variantIds = [...new Set(input.items.map((i) => i.variantId))];
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: { product: { select: { isActive: true, deletedAt: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const hasCostAccess = await can(actor, "product.cost.view");
    const hasStockOverride = await can(actor, "order.stock_override");
    const newQtyByVariant = new Map<string, number>();

    for (const item of input.items) {
      const variant = variantById.get(item.variantId);
      if (!variant || !variant.isActive || !variant.product || variant.product.deletedAt) {
        return { ok: false, error: "One of the selected items is no longer available", status: 400 };
      }
      if (isPriceBelowFloor(item.unitPrice, toNumber(variant.weightedAvgCost), hasCostAccess)) {
        return {
          ok: false,
          error: `Unit price for ${variant.sku} is below the minimum allowed. Increase the price or ask a Manager/Admin.`,
          status: 400,
        };
      }
      newQtyByVariant.set(item.variantId, (newQtyByVariant.get(item.variantId) ?? 0) + item.qty);
    }

    for (const [variantId, newQty] of newQtyByVariant) {
      const variant = variantById.get(variantId)!;
      const alreadyReservedHere = oldQtyByVariant.get(variantId) ?? 0;
      const available = variant.stockQty - variant.reservedQty + alreadyReservedHere;
      if (newQty > available) {
        if (!hasStockOverride) {
          return { ok: false, error: `Not enough stock for ${variant.sku} (${available} available, ${newQty} requested)`, status: 400 };
        }
        const line = input.items.find((i) => i.variantId === variantId);
        if (!line?.stockOverrideReason) {
          return { ok: false, error: `A reason is required to sell ${variant.sku} below available stock`, status: 400 };
        }
      }
    }

    validatedItems = input.items.map((item) => {
      const variant = variantById.get(item.variantId)!;
      const alreadyReservedHere = oldQtyByVariant.get(item.variantId) ?? 0;
      const newQty = newQtyByVariant.get(item.variantId)!;
      const available = variant.stockQty - variant.reservedQty + alreadyReservedHere;
      return { ...item, stockOverrideReason: newQty > available ? item.stockOverrideReason : undefined };
    });
  }

  const effectiveDeliveryCharge = input.deliveryCharge ?? toNumber(existing.deliveryCharge);
  const effectiveItems = (validatedItems ?? existing.items).map((item) => ({
    qty: item.qty,
    unitPrice: toNumber(item.unitPrice),
    lineDiscount: toNumber(item.lineDiscount),
  }));
  const totals = computeOrderTotals(effectiveItems, effectiveDeliveryCharge);
  const paidSoFar = existing.payments.reduce((sum, p) => sum + toNumber(p.amount), 0);
  const dueAmount = computeDueAmount(totals.total, paidSoFar);

  return {
    ok: true,
    validatedItems,
    effectiveDeliveryCharge,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    total: totals.total,
    dueAmount,
  };
}

/** Writes a validated edit. Caller must have just produced `validation` from validateOrderEdit — never pass a stale one across an await boundary that could let state drift. */
export async function applyValidatedOrderEdit(orderId: string, input: OrderEditInput, validation: Extract<OrderEditValidation, { ok: true }>) {
  return prisma.$transaction(async (tx) => {
    if (validation.validatedItems) {
      const existingItems = await tx.orderItem.findMany({ where: { orderId } });
      for (const item of existingItems) {
        await releaseVariantStock(tx, item.variantId, item.qty);
      }
      await tx.orderItem.deleteMany({ where: { orderId } });
      for (const item of validation.validatedItems) {
        const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: item.variantId } });
        const available = variant.stockQty - variant.reservedQty;
        const isOverride = item.qty > available;
        await tx.orderItem.create({
          data: {
            orderId,
            variantId: item.variantId,
            qty: item.qty,
            unitPrice: item.unitPrice,
            lineDiscount: item.lineDiscount,
            stockOverride: isOverride,
            stockOverrideReason: isOverride ? (item.stockOverrideReason ?? null) : null,
          },
        });
        await reserveVariantStock(tx, item.variantId, item.qty);
      }
    }

    return tx.order.update({
      where: { id: orderId },
      data: {
        courierId: input.courierId === undefined ? undefined : input.courierId || null,
        courierZoneId: input.courierZoneId === undefined ? undefined : input.courierZoneId || null,
        deliveryCharge: validation.effectiveDeliveryCharge,
        expectedDeliveryDate: input.expectedDeliveryDate === undefined ? undefined : input.expectedDeliveryDate,
        internalNote: input.internalNote === undefined ? undefined : input.internalNote || null,
        deliveryNote: input.deliveryNote === undefined ? undefined : input.deliveryNote || null,
        subtotal: validation.subtotal,
        discountTotal: validation.discountTotal,
        total: validation.total,
        dueAmount: validation.dueAmount,
      },
    });
  });
}
