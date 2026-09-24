import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { toNumber } from "@/lib/money";
import { DIRECTLY_EDITABLE_STATUSES, type OrderStatusValue } from "@/lib/orders/constants";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { releaseVariantStock, reserveVariantStock } from "@/lib/orders/stock";
import { computeDueAmount, computeOrderTotals, COUNTED_PAYMENTS_WHERE, recomputeOrderDueAmount } from "@/lib/orders/totals";
import { resolveSetLines, writeSetLines, type ResolvedSetLine } from "@/lib/sets/order-lines";
import { SetError } from "@/lib/sets/service";
import type { SetLineInput } from "@/lib/sets/types";

// Shared by the direct in-window PATCH (app/api/orders/[id]/route.ts) and
// the TL/Admin edit-request approval (app/api/order-edit-requests/[id]/
// route.ts) — both end up applying the exact same kind of change to an
// order, and both need to re-validate against *current* stock/price-floor
// state right before writing (an edit request can sit PENDING long enough
// for either to have moved).
//
// Only LEAD/CONFIRMED orders are ever edited. Once packed, the lines carry
// frozen cost snapshots and their stock has left the shelf through the
// ledger — rewriting them would release reservations that no longer exist
// and lose the snapshots (CLAUDE.md rules 2, 3, 10). An edit request filed
// while CONFIRMED and approved after packing is therefore refused.

export class OrderEditConflictError extends Error {}

/** An order's set lines as the edit form sends them back: set, qty, price, discount and the chosen variant per component product. */
export function existingSetInputs(
  setLines: { outfitSetId: string; qty: number; unitPrice: Prisma.Decimal; lineDiscount: Prisma.Decimal; items: { variantId: string; variant: { productId: string } }[] }[],
): SetLineInput[] {
  return setLines.map((s) => ({
    setId: s.outfitSetId,
    qty: s.qty,
    unitPrice: toNumber(s.unitPrice),
    lineDiscount: toNumber(s.lineDiscount),
    choices: s.items.map((i) => ({ productId: i.variant.productId, variantId: i.variantId })),
  }));
}

const notEditableMessage = (status: string) => `This order is ${status} now — it can only be edited while it is a lead or confirmed.`;

export type OrderEditItemInput = {
  variantId: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  stockOverrideReason?: string;
};

export type OrderEditInput = {
  /** The order's plain lines. With `sets`, the full new set of lines: either one given replaces all lines (the other stays as it is). */
  items?: OrderEditItemInput[];
  /** P3.3 — the order's outfit sets, with their chosen sizes/colours. */
  sets?: SetLineInput[];
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
      /** P3.3 — the sets, exploded; set whenever the lines change. */
      validatedSets: ResolvedSetLine[] | null;
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
    sets: Array.isArray(obj.sets) ? (obj.sets as SetLineInput[]) : undefined,
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
    include: {
      items: true,
      setLines: { include: { items: { select: { variantId: true, variant: { select: { productId: true } } } } } },
      payments: { where: COUNTED_PAYMENTS_WHERE, select: { amount: true } },
    },
  });
  if (!existing) return { ok: false, error: "Order not found", status: 404 };
  if (!DIRECTLY_EDITABLE_STATUSES.includes(existing.status as OrderStatusValue)) {
    return { ok: false, error: notEditableMessage(existing.status), status: 409 };
  }

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
  let validatedSets: ResolvedSetLine[] | null = null;

  if (input.items || input.sets) {
    // Either list given replaces the order's lines; the other is kept as it is.
    const newItems: OrderEditItemInput[] =
      input.items ??
      existing.items
        .filter((i) => i.setLineId === null)
        .map((i) => ({ variantId: i.variantId, qty: i.qty, unitPrice: toNumber(i.unitPrice), lineDiscount: toNumber(i.lineDiscount), stockOverrideReason: i.stockOverrideReason ?? undefined }));
    const newSetInputs: SetLineInput[] = input.sets ?? existingSetInputs(existing.setLines);
    if (newItems.length + newSetInputs.length === 0) return { ok: false, error: "An order needs at least one item.", status: 400 };

    const hasCostAccess = await can(actor, "product.cost.view");
    const hasStockOverride = await can(actor, "order.stock_override");
    try {
      validatedSets = await resolveSetLines(prisma, newSetInputs, { hasCostAccess });
    } catch (error) {
      if (error instanceof SetError) return { ok: false, error: error.message, status: error.status };
      throw error;
    }
    const setChildren = validatedSets.flatMap((s) => s.children.map((c) => ({ ...c, stockOverrideReason: s.stockOverrideReason ?? undefined, fromSet: true })));
    const allLines = [...newItems.map((i) => ({ ...i, fromSet: false })), ...setChildren];

    const variantIds = [...new Set(allLines.map((i) => i.variantId))];
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: { product: { select: { isActive: true, deletedAt: true, kind: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const newQtyByVariant = new Map<string, number>();

    for (const item of allLines) {
      const variant = variantById.get(item.variantId);
      if (!variant || !variant.isActive || !variant.product || variant.product.deletedAt || variant.product.kind !== "SELLABLE") {
        return { ok: false, error: "One of the selected items is no longer available", status: 400 };
      }
      if (!item.fromSet && isPriceBelowFloor(item.unitPrice, toNumber(variant.weightedAvgCost), hasCostAccess)) {
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
        const line = allLines.find((i) => i.variantId === variantId && i.stockOverrideReason);
        if (!line?.stockOverrideReason) {
          return { ok: false, error: `A reason is required to sell ${variant.sku} below available stock`, status: 400 };
        }
      }
    }

    validatedItems = newItems.map((item) => {
      const variant = variantById.get(item.variantId)!;
      const alreadyReservedHere = oldQtyByVariant.get(item.variantId) ?? 0;
      const newQty = newQtyByVariant.get(item.variantId)!;
      const available = variant.stockQty - variant.reservedQty + alreadyReservedHere;
      return { ...item, stockOverrideReason: newQty > available ? item.stockOverrideReason : undefined };
    });
  }

  const effectiveDeliveryCharge = input.deliveryCharge ?? toNumber(existing.deliveryCharge);
  const effectiveItems = (validatedItems ? [...validatedItems, ...validatedSets!.flatMap((s) => s.children)] : existing.items).map((item) => ({
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
    validatedSets,
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
    // Lock the order and re-check its status: packing (or a cancel) that
    // committed after validation must win, and one that starts now waits.
    const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
    if (!locked) throw new OrderEditConflictError("Order not found");
    if (!DIRECTLY_EDITABLE_STATUSES.includes(locked.status as OrderStatusValue)) throw new OrderEditConflictError(notEditableMessage(locked.status));

    if (validation.validatedItems) {
      const existingItems = await tx.orderItem.findMany({ where: { orderId } });
      for (const item of existingItems) {
        await releaseVariantStock(tx, item.variantId, item.qty);
      }
      await tx.orderItem.deleteMany({ where: { orderId } });
      await tx.orderSetLine.deleteMany({ where: { orderId } });
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
      // P3.3 — the sets' component lines, reserved like any line.
      const overrideByVariant = new Map<string, string>();
      for (const s of validation.validatedSets ?? []) for (const c of s.children) if (s.stockOverrideReason) overrideByVariant.set(c.variantId, s.stockOverrideReason);
      for (const child of await writeSetLines(tx, orderId, validation.validatedSets ?? [], { overrideByVariant })) {
        await reserveVariantStock(tx, child.variantId, child.qty);
      }
    }

    await tx.order.update({
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
      },
    });
    // CLAUDE.md rule 1 — from the payments as they stand inside this transaction.
    await recomputeOrderDueAmount(tx, orderId);
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}
