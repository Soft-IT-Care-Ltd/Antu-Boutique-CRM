import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { writeAuditLogWith } from "@/lib/audit/log";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import { settleFulfilment } from "@/lib/fulfilment/settle";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { toNumber } from "@/lib/money";
import { PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { releaseVariantStock, reserveVariantStock } from "@/lib/orders/stock";
import { computeOrderTotals, recomputeOrderDueAmount } from "@/lib/orders/totals";
import { refundableAmount, RefundError, requestRefund } from "@/lib/payments/refunds";
import { issueStoreCredit, StoreCreditError } from "@/lib/store-credit/ledger";

// C5 — CORRECTIONS.md item 12, "Changes to existing rules" 3: the four
// fulfilment actions on an order with a missing item — the one controlled
// exception to "no edits once Confirmed". Used by packing, a location
// incharge or the SE after calling the customer (order.fulfilment, on an
// order the person can see):
//   SUBSTITUTE   replace the missing units with another product/variant the
//                customer agreed to (a set's piece: another size/colour of it)
//   WAIT         keep waiting (optional expected date)
//   REMOVE_ITEM  drop the missing units and ship the rest
//   CANCEL       cancel for a stock-out (some unit is nowhere)
// Each needs a reason, is audit-logged, recomputes total and due (rule 1),
// and is followed by a new invoice version (invariant 8). When the customer
// has paid more than the new total, the difference follows the P3.2 rules:
// store credit at once, or a refund request a second person approves — and
// only someone who sees the order's money may choose (packing may not).
// REMOVE_ITEM and CANCEL rows in fulfilment_actions are the lost sales.

export class FulfilmentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const reason = z.string().trim().min(3, "Give the reason (what the customer said)").max(300);
const settlementSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("STORE_CREDIT") }),
    z.object({ kind: z.literal("REFUND"), method: z.enum(PAYMENT_METHOD_VALUES), walletId: z.string().trim().min(1).max(50).nullish() }),
  ])
  .nullish();
const itemId = z.string().trim().min(1).max(50);
const units = z.coerce.number().int().min(1).max(999);

export const fulfilmentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("SUBSTITUTE"),
    orderItemId: itemId,
    /** Units of the line being replaced (default: those not at the hub). */
    qty: units.optional(),
    variantId: z.string().cuid(),
    /** Units of the substitute (default: the same). */
    newQty: units.optional(),
    unitPrice: z.coerce.number().min(0).max(10_000_000),
    lineDiscount: z.coerce.number().min(0).max(10_000_000).default(0),
    reason,
    settlement: settlementSchema,
  }),
  z.object({
    action: z.literal("WAIT"),
    reason,
    expectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date").nullish(),
  }),
  z.object({ action: z.literal("REMOVE_ITEM"), orderItemId: itemId, qty: units.optional(), reason, settlement: settlementSchema }),
  z.object({ action: z.literal("CANCEL"), reason, settlement: settlementSchema }),
]);
export type FulfilmentActionInput = z.infer<typeof fulfilmentActionSchema>;

export type FulfilmentActionResult = {
  orderId: string;
  status: string;
  fulfilmentStatus: string | null;
  settlement: { kind: "STORE_CREDIT" | "REFUND"; amount: string } | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
/** A line's value to the customer, in paisa. */
const lineValuePaisa = (qty: number, unitPrice: Prisma.Decimal | number, lineDiscount: Prisma.Decimal | number) => Math.max(0, qty * toPaisa(unitPrice) - toPaisa(lineDiscount));

async function snapshot(tx: Prisma.TransactionClient, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      fulfilmentStatus: true,
      stockExpectedOn: true,
      subtotal: true,
      discountTotal: true,
      total: true,
      dueAmount: true,
      items: { orderBy: { createdAt: "asc" }, select: { id: true, qty: true, unitPrice: true, lineDiscount: true, backorderQty: true, atHubQty: true, variant: { select: { sku: true } } } },
    },
  });
  return {
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    stockExpectedOn: o.stockExpectedOn?.toISOString() ?? null,
    subtotal: o.subtotal.toString(),
    discountTotal: o.discountTotal.toString(),
    total: o.total.toString(),
    dueAmount: o.dueAmount.toString(),
    items: o.items.map((i) => ({ id: i.id, sku: i.variant.sku, qty: i.qty, unitPrice: i.unitPrice.toString(), lineDiscount: i.lineDiscount.toString(), atHub: i.atHubQty, backorder: i.backorderQty })),
  };
}

/** Total and due from the lines as they are now (CLAUDE.md rule 1). */
async function recomputeTotals(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { deliveryCharge: true, items: { select: { qty: true, unitPrice: true, lineDiscount: true } } } });
  const totals = computeOrderTotals(
    order.items.map((i) => ({ qty: i.qty, unitPrice: toNumber(i.unitPrice), lineDiscount: toNumber(i.lineDiscount) })),
    toNumber(order.deliveryCharge),
  );
  await tx.order.update({ where: { id: orderId }, data: { subtotal: round2(totals.subtotal), discountTotal: round2(totals.discountTotal), total: round2(totals.total) } });
  return recomputeOrderDueAmount(tx, orderId);
}

/**
 * Takes `qty` units off a line: deletes it, or lowers it with its discount
 * pro rata. Releases their reservation. Returns the value taken off (paisa).
 */
async function takeUnitsOffLine(tx: Prisma.TransactionClient, item: { id: string; variantId: string; qty: number; unitPrice: Prisma.Decimal; lineDiscount: Prisma.Decimal }, qty: number): Promise<number> {
  await releaseVariantStock(tx, item.variantId, qty);
  const discountPaisa = toPaisa(item.lineDiscount);
  if (qty === item.qty) {
    await tx.orderItem.delete({ where: { id: item.id } });
    return lineValuePaisa(item.qty, item.unitPrice, item.lineDiscount);
  }
  const keptDiscount = Math.round((discountPaisa * (item.qty - qty)) / item.qty);
  await tx.orderItem.update({ where: { id: item.id }, data: { qty: item.qty - qty, lineDiscount: fromPaisa(keptDiscount) } });
  return Math.max(0, qty * toPaisa(item.unitPrice) - (discountPaisa - keptDiscount));
}

export async function applyFulfilmentAction(db: Db, user: SessionUser, orderId: string, raw: FulfilmentActionInput, meta: { request?: Request } = {}): Promise<FulfilmentActionResult> {
  // Validated here too (the route already did): seeds, tests and any future caller get the same rules.
  const parsed = fulfilmentActionSchema.safeParse(raw);
  if (!parsed.success) throw new FulfilmentError(parsed.error.issues[0]?.message ?? "Invalid input");
  const input = parsed.data;
  const canSettle = await can(user, ["order.view_own", "order.view_team", "order.view_all"]);
  const hasCostAccess = await can(user, "product.cost.view");

  return withTx(db, async (tx) => {
    // The order row first: an edit, a pack or another action waits.
    const [locked] = await tx.$queryRaw<{ status: string; channel: string; deletedAt: Date | null }[]>`
      SELECT "status"::text AS "status", "channel"::text AS "channel", "deletedAt" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE
    `;
    if (!locked || locked.deletedAt) throw new FulfilmentError("Order not found", 404);
    if (locked.channel !== "ONLINE" || locked.status !== "CONFIRMED") throw new FulfilmentError("Fulfilment actions are for confirmed online orders that aren't packed yet.", 409);

    // Fresh: who has which unit right now.
    await settleFulfilment(tx);
    const before = await snapshot(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        orderNo: true,
        customerId: true,
        items: { orderBy: { createdAt: "asc" }, select: { id: true, variantId: true, qty: true, unitPrice: true, lineDiscount: true, setLineId: true, atHubQty: true, backorderQty: true, variant: { select: { sku: true, productId: true } } } },
      },
    });

    const line = "orderItemId" in input ? order.items.find((i) => i.id === input.orderItemId) : undefined;
    if ("orderItemId" in input && !line) throw new FulfilmentError("That item isn't on this order any more — reload the order.", 409);
    const notAtHub = line ? line.qty - line.atHubQty : 0;
    if (line && notAtHub <= 0) throw new FulfilmentError(`${line.variant.sku} is at the packing hub — nothing on that line is missing.`, 409);
    const missingQty = (q: number | undefined) => {
      const n = q ?? notAtHub;
      if (n > line!.qty) throw new FulfilmentError(`That line has only ${line!.qty}.`);
      return n;
    };

    const actionRows: Prisma.FulfilmentActionCreateManyInput[] = [];
    let lostPaisa = 0;

    switch (input.action) {
      case "WAIT": {
        if (before.fulfilmentStatus === "READY_TO_PACK") throw new FulfilmentError("Everything on this order is at the packing hub — there is nothing to wait for.", 409);
        const expectedOn = input.expectedOn ? dhakaDayStartUtc(input.expectedOn) : null;
        await tx.order.update({ where: { id: orderId }, data: { stockExpectedOn: expectedOn } });
        actionRows.push({ orderId, kind: "WAIT", reason: input.reason, expectedOn, actorId: user.id });
        break;
      }
      case "REMOVE_ITEM": {
        const qty = missingQty(input.qty);
        const remaining = order.items.reduce((sum, i) => sum + i.qty, 0) - qty;
        if (remaining <= 0) throw new FulfilmentError("That would leave the order empty — cancel it for the stock-out instead.", 409);
        const value = await takeUnitsOffLine(tx, line!, qty);
        lostPaisa += value;
        actionRows.push({ orderId, kind: "REMOVE_ITEM", orderItemId: line!.id, variantId: line!.variantId, qty, value: fromPaisa(value), reason: input.reason, actorId: user.id });
        break;
      }
      case "SUBSTITUTE": {
        const qty = missingQty(input.qty);
        const newQty = input.newQty ?? qty;
        if (input.variantId === line!.variantId) throw new FulfilmentError("Pick a different item to send instead.");
        const variant = await tx.productVariant.findUnique({
          where: { id: input.variantId },
          select: { id: true, sku: true, isActive: true, productId: true, weightedAvgCost: true, product: { select: { isActive: true, deletedAt: true, kind: true } } },
        });
        if (!variant || !variant.isActive || !variant.product.isActive || variant.product.deletedAt || variant.product.kind !== "SELLABLE") throw new FulfilmentError("That item can't be sold.");
        // P3.3 — a set's piece can only become another size/colour of the same product.
        if (line!.setLineId && variant.productId !== line!.variant.productId) {
          throw new FulfilmentError("A piece of an outfit set can only be swapped for another size or colour of the same product — or remove it.");
        }
        if (!line!.setLineId && isPriceBelowFloor(input.unitPrice, toNumber(variant.weightedAvgCost), hasCostAccess)) {
          throw new FulfilmentError(`Unit price for ${variant.sku} is below the minimum allowed. Increase the price or ask a Manager/Admin.`);
        }
        const replacedValue = lineValuePaisa(qty, line!.unitPrice, qty === line!.qty ? line!.lineDiscount : 0);
        if (qty === line!.qty && newQty === qty && line!.setLineId) {
          // A set's piece keeps its share of the set's price.
          await releaseVariantStock(tx, line!.variantId, qty);
          await tx.orderItem.update({ where: { id: line!.id }, data: { variantId: variant.id } });
          await reserveVariantStock(tx, variant.id, qty);
        } else {
          await takeUnitsOffLine(tx, line!, qty);
          await tx.orderItem.create({
            data: { orderId, variantId: variant.id, qty: newQty, unitPrice: input.unitPrice, lineDiscount: input.lineDiscount, setLineId: line!.setLineId },
          });
          await reserveVariantStock(tx, variant.id, newQty);
        }
        actionRows.push({
          orderId,
          kind: "SUBSTITUTE",
          orderItemId: line!.id,
          variantId: line!.variantId,
          qty,
          value: fromPaisa(replacedValue),
          substituteVariantId: variant.id,
          substituteQty: newQty,
          reason: input.reason,
          actorId: user.id,
        });
        break;
      }
      case "CANCEL": {
        if (!order.items.some((i) => i.backorderQty > 0)) {
          throw new FulfilmentError("Nothing on this order is out of stock — cancel it from the status menu if the customer changed their mind.", 409);
        }
        for (const i of order.items) {
          const value = lineValuePaisa(i.qty, i.unitPrice, i.lineDiscount);
          lostPaisa += value;
          actionRows.push({ orderId, kind: "CANCEL", orderItemId: i.id, variantId: i.variantId, qty: i.qty, value: fromPaisa(value), reason: input.reason, actorId: user.id });
        }
        // Releases every reservation, gives back store credit spent on it, settles fulfilment.
        await moveOrderStatus(tx, { id: orderId, status: "CONFIRMED", items: [] }, "CANCELLED", user.id, `Cancelled for a stock-out: ${input.reason}`);
        break;
      }
    }

    // Totals and due (rule 1); a cancelled order keeps its total, and what was paid is now owed back.
    const due = input.action === "CANCEL" ? await recomputeOrderDueAmount(tx, orderId) : await recomputeTotals(tx, orderId);
    const final = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } });
    const owedPaisa = input.action === "CANCEL" ? toPaisa(final.total) - toPaisa(due) : -toPaisa(due);

    let settlement: FulfilmentActionResult["settlement"] = null;
    if (owedPaisa > 0 && input.action !== "WAIT") {
      const chosen = "settlement" in input ? input.settlement : null;
      if (!canSettle) throw new FulfilmentError(`The customer has paid ${fromPaisa(owedPaisa)} more than the new total — ask the sales executive to do this, so the difference goes back the right way.`, 403);
      if (!chosen) throw new FulfilmentError(`The customer has paid ${fromPaisa(owedPaisa)} more than the new total. Choose store credit or a refund for the difference.`, 409, { overpaid: fromPaisa(owedPaisa) });
      // Only money that has been checked goes back (P3.2): what can be refunded, plus store credit spent here.
      const verified = toPaisa(await refundableAmount(tx, orderId));
      if (chosen.kind === "STORE_CREDIT") {
        if (!order.customerId) throw new FulfilmentError("This order has no customer to give store credit to.");
        if (owedPaisa > verified) throw new FulfilmentError(`Only ${fromPaisa(verified)} of what was paid is verified — Accounts must verify the payment before the difference can go back.`, 409);
        await issueStoreCredit(tx, { customerId: order.customerId, orderId, amountPaisa: owedPaisa, reason: `Stock-out on ${order.orderNo}: ${input.reason}`, actorId: user.id });
      } else {
        await requestRefund(tx, orderId, { amount: Number(fromPaisa(owedPaisa)), method: chosen.method, walletId: chosen.walletId ?? null, reason: `Stock-out on ${order.orderNo}: ${input.reason}` }, user.id);
      }
      settlement = { kind: chosen.kind, amount: fromPaisa(owedPaisa) };
      actionRows[0] = { ...actionRows[0], settlement: chosen.kind, settlementAmount: fromPaisa(owedPaisa) };
    }

    await tx.fulfilmentAction.createMany({ data: actionRows });
    await settleFulfilment(tx);
    const after = await snapshot(tx, orderId);
    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: `order.fulfilment.${input.action.toLowerCase()}`,
      entityType: "order",
      entityId: orderId,
      before,
      after: { ...after, reason: input.reason, lostValue: lostPaisa > 0 ? fromPaisa(lostPaisa) : undefined, settlement },
      request: meta.request,
    });
    return { orderId, status: after.status, fulfilmentStatus: after.fulfilmentStatus, settlement };
  }).catch((error: unknown) => {
    if (error instanceof RefundError || error instanceof StoreCreditError) throw new FulfilmentError(error.message, error.status);
    throw error;
  });
}
