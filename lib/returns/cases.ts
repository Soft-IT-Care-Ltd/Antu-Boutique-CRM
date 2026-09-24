import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { lockVariant, recordStockMovement } from "@/lib/inventory/ledger";
import { formatBDT, toNumber } from "@/lib/money";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { isTransitionAllowed, moveOrderStatus, revertOrderStatus } from "@/lib/orders/lifecycle";
import { generateOrderNumber } from "@/lib/orders/order-number";
import { reserveVariantStock } from "@/lib/orders/stock";
import { computeOrderTotals, keptLine, recomputeOrderDueAmount } from "@/lib/orders/totals";
import { settleTenders } from "@/lib/pos/cart";
import type { PosPaymentMethod } from "@/lib/pos/constants";
import { lockOpenDrawerForSale } from "@/lib/pos/drawer";
import { completeConditionCheck, openReturnInspection } from "@/lib/returns/condition-check";
import { RETURN_REASON_LABELS, RETURNABLE_ORDER_STATUSES, type CourierChargeBearerValue, type ReturnReasonValue } from "@/lib/returns/constants";
import { resolvePaymentWalletId } from "@/lib/wallets/service";

// ============ Returns and exchanges (PRD §4.11, P3.2) ============
//
// ONLINE (the item comes back by courier):
//   request (reason required) → TL/Manager/Admin approves, someone other
//   than the requester → APPROVED: the money and the replacement are set up,
//   and a Packing condition check waits for the item → the check completes
//   the case (lib/returns/case-completion.ts). No stock moves until then.
// COUNTER (the customer is in the showroom with the item): inspected,
//   swapped and settled on the spot, both stock movements in one
//   transaction. Created COMPLETED.
//
// Money. The returned units are marked on their order line (returnedQty,
// the same field a partial delivery uses) and the original total is
// recomputed on what the customer keeps, so COGS and revenue both leave
// with the item (PRD §4.12: COGS counts qty − returnedQty). The value that
// came back is the customer's credit:
//   - a return: the original is overpaid by it — refunded through the P2.3
//     refund flow (approved by a second person); a fully returned order is
//     RETURNED, then REFUNDED once a refund is approved
//   - an exchange: it moves to the replacement order as a pair of
//     EXCHANGE_CREDIT rows (−credit / +credit, no wallet, no money). The
//     customer pays any difference on the replacement like any payment; if
//     the replacement is cheaper, the rest stays on the original as credit
//     to refund.
// Every item goes back through the one condition-check service
// (lib/returns/condition-check.ts): Good → EXCHANGE_IN / RETURN_IN,
// Damaged → DAMAGE_OUT at the frozen cost.

export class ReturnCaseError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type CaseLineInput = { orderItemId: string; qty: number; replacementVariantId?: string | null };

const round2 = (n: number) => Math.round(n * 100) / 100;

const ORDER_FOR_CASE_SELECT = {
  id: true,
  orderNo: true,
  status: true,
  channel: true,
  customerId: true,
  courierId: true,
  courierZoneId: true,
  courierZone: { select: { charge: true } },
  deliveryCharge: true,
  deliveryNote: true,
  createdById: true,
  teamId: true,
  subtotal: true,
  discountTotal: true,
  total: true,
  deletedAt: true,
  items: {
    select: {
      id: true,
      qty: true,
      returnedQty: true,
      unitPrice: true,
      lineDiscount: true,
      unitCostSnapshot: true,
      variantId: true,
      variant: { select: { sku: true, productId: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } },
    },
  },
} satisfies Prisma.OrderSelect;

type OrderForCase = Prisma.OrderGetPayload<{ select: typeof ORDER_FOR_CASE_SELECT }>;
type ItemForCase = OrderForCase["items"][number];

const itemLabel = (i: ItemForCase) => `${i.variant.product.name} (${i.variant.size.name}, ${i.variant.color.name})`;

async function loadOrder(tx: Prisma.TransactionClient, orderId: string): Promise<OrderForCase> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: ORDER_FOR_CASE_SELECT });
  if (!order || order.deletedAt) throw new ReturnCaseError("Order not found", 404);
  return order;
}

function assertReturnable(order: OrderForCase) {
  if (!RETURNABLE_ORDER_STATUSES.includes(order.status as OrderStatusValue)) {
    throw new ReturnCaseError(`Only items the customer has received can be returned or exchanged — this order is ${order.status.replaceAll("_", " ").toLowerCase()}.`, 409);
  }
}

/**
 * Units of each line the customer can still send back: packed, not
 * already returned, and not in another request waiting for approval.
 */
export async function returnableQtyByItem(tx: Prisma.TransactionClient, order: OrderForCase, excludeCaseId?: string): Promise<Map<string, number>> {
  const requested = await tx.returnCaseLine.groupBy({
    by: ["orderItemId"],
    where: { returnCase: { orderId: order.id, status: "REQUESTED", ...(excludeCaseId ? { id: { not: excludeCaseId } } : {}) } },
    _sum: { qty: true },
  });
  const pending = new Map(requested.map((r) => [r.orderItemId, r._sum.qty ?? 0]));
  return new Map(order.items.filter((i) => i.unitCostSnapshot !== null).map((i) => [i.id, Math.max(0, i.qty - i.returnedQty - (pending.get(i.id) ?? 0))]));
}

function validateLines(order: OrderForCase, lines: CaseLineInput[], returnable: Map<string, number>) {
  if (lines.length === 0) throw new ReturnCaseError("Pick at least one item.");
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.orderItemId)) throw new ReturnCaseError("Each item may only appear once.");
    seen.add(line.orderItemId);
    const item = order.items.find((i) => i.id === line.orderItemId);
    if (!item) throw new ReturnCaseError("That item is not part of this order.");
    const max = returnable.get(item.id) ?? 0;
    if (!Number.isInteger(line.qty) || line.qty < 1) throw new ReturnCaseError(`${itemLabel(item)}: enter how many are coming back.`);
    if (line.qty > max) {
      throw new ReturnCaseError(
        max === 0 ? `${itemLabel(item)} can't be returned — it's already returned or in another request.` : `${itemLabel(item)}: only ${max} can come back.`,
        409,
      );
    }
  }
}

type ReplacementVariant = { id: string; sku: string; productId: string; stockQty: number; reservedQty: number; weightedAvgCost: Prisma.Decimal; price: Prisma.Decimal; label: string };

/** The replacement variants, locked in id order, each checked for sale and for stock to cover every unit asked of it. */
async function lockReplacements(tx: Prisma.TransactionClient, order: OrderForCase, lines: CaseLineInput[]): Promise<Map<string, ReplacementVariant>> {
  const wanted = new Map<string, number>();
  for (const line of lines) {
    if (!line.replacementVariantId) throw new ReturnCaseError("Pick what the customer gets instead for every item.");
    const item = order.items.find((i) => i.id === line.orderItemId)!;
    if (line.replacementVariantId === item.variantId) throw new ReturnCaseError(`${itemLabel(item)}: pick a different size or colour to exchange for.`);
    wanted.set(line.replacementVariantId, (wanted.get(line.replacementVariantId) ?? 0) + line.qty);
  }
  const ids = [...wanted.keys()].sort();
  for (const id of ids) if (!(await lockVariant(tx, id))) throw new ReturnCaseError("One of the replacement items is no longer in the catalog.");
  const variants = await tx.productVariant.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      sku: true,
      productId: true,
      stockQty: true,
      reservedQty: true,
      weightedAvgCost: true,
      priceOverride: true,
      isActive: true,
      size: { select: { name: true } },
      color: { select: { name: true } },
      product: { select: { name: true, basePrice: true, isActive: true, deletedAt: true } },
    },
  });
  const byId = new Map<string, ReplacementVariant>();
  for (const v of variants) {
    const label = `${v.product.name} (${v.size.name}, ${v.color.name})`;
    if (!v.isActive || !v.product.isActive || v.product.deletedAt) throw new ReturnCaseError(`${label} is no longer for sale.`);
    const available = v.stockQty - v.reservedQty;
    const qty = wanted.get(v.id)!;
    if (qty > available) throw new ReturnCaseError(`Only ${Math.max(0, available)} of ${label} available (${qty} needed for this exchange).`, 409);
    byId.set(v.id, { id: v.id, sku: v.sku, productId: v.productId, stockQty: v.stockQty, reservedQty: v.reservedQty, weightedAvgCost: v.weightedAvgCost, price: v.priceOverride ?? v.product.basePrice, label });
  }
  if (byId.size !== ids.length) throw new ReturnCaseError("One of the replacement items is no longer in the catalog.");
  return byId;
}

/**
 * The replacement's price. The same product in another size or colour keeps
 * what the customer paid for it (unit price and its share of the line
 * discount), so a plain size swap costs nothing; another product is sold at
 * today's price.
 */
function priceReplacement(item: ItemForCase, qty: number, replacement: ReplacementVariant): { unitPrice: number; lineDiscount: number } {
  if (replacement.productId === item.variant.productId) {
    return { unitPrice: toNumber(item.unitPrice), lineDiscount: round2((toNumber(item.lineDiscount) * qty) / item.qty) };
  }
  return { unitPrice: toNumber(replacement.price), lineDiscount: 0 };
}

/**
 * Marks units as returned on their order lines (or, with sign −1, takes
 * that back) and moves the order total by exactly their value — the
 * difference keptLine() makes — so an order whose stored total ever
 * differed from its lines only moves by what came back. Returns that value.
 */
async function applyReturnedUnits(tx: Prisma.TransactionClient, order: OrderForCase, lines: { orderItemId: string; qty: number }[], sign: 1 | -1): Promise<number> {
  const qtyById = new Map(lines.map((l) => [l.orderItemId, l.qty * sign]));
  const priced = (withChange: boolean) =>
    order.items.map((i) =>
      keptLine({ qty: i.qty, returnedQty: i.returnedQty + (withChange ? (qtyById.get(i.id) ?? 0) : 0), unitPrice: toNumber(i.unitPrice), lineDiscount: toNumber(i.lineDiscount) }),
    );
  const before = computeOrderTotals(priced(false), 0);
  const after = computeOrderTotals(priced(true), 0);
  const valuePaisa = toPaisa(before.total) - toPaisa(after.total);

  for (const [orderItemId, delta] of qtyById) {
    await tx.orderItem.update({ where: { id: orderItemId }, data: { returnedQty: { increment: delta } } });
  }
  await tx.order.update({
    where: { id: order.id },
    data: {
      subtotal: fromPaisa(toPaisa(order.subtotal) - (toPaisa(before.subtotal) - toPaisa(after.subtotal))),
      discountTotal: fromPaisa(toPaisa(order.discountTotal) - (toPaisa(before.discountTotal) - toPaisa(after.discountTotal))),
      total: fromPaisa(toPaisa(order.total) - valuePaisa),
    },
  });
  await recomputeOrderDueAmount(tx, order.id);
  return Math.abs(valuePaisa);
}

/** −credit on the original, +credit on the replacement: as much of the returned value as the replacement costs. */
async function transferExchangeCredit(
  tx: Prisma.TransactionClient,
  input: { caseId: string; original: { id: string; orderNo: string }; replacement: { id: string; orderNo: string; total: Prisma.Decimal | number }; valuePaisa: number; actorId: string },
): Promise<number> {
  const creditPaisa = Math.min(input.valuePaisa, toPaisa(input.replacement.total));
  if (creditPaisa > 0) {
    const base = { kind: "EXCHANGE_CREDIT" as const, method: "EXCHANGE_CREDIT" as const, verified: true, verifiedAt: new Date(), verifiedById: input.actorId, receivedById: input.actorId, returnCaseId: input.caseId };
    await tx.payment.create({ data: { ...base, orderId: input.original.id, amount: -fromPaisa(creditPaisa), note: `Exchange credit carried to ${input.replacement.orderNo}` } });
    await tx.payment.create({ data: { ...base, orderId: input.replacement.id, amount: fromPaisa(creditPaisa), note: `Exchange credit from ${input.original.orderNo}` } });
  }
  await recomputeOrderDueAmount(tx, input.original.id);
  await recomputeOrderDueAmount(tx, input.replacement.id);
  return creditPaisa;
}

// ---------------------------------------------------------------------------
// Online: request → approve / reject → (condition check completes it)
// ---------------------------------------------------------------------------

export type RequestCaseInput = {
  orderId: string;
  type: "RETURN" | "EXCHANGE";
  reason: ReturnReasonValue;
  reasonNote?: string | null;
  courierChargeBearer?: CourierChargeBearerValue | null;
  lines: CaseLineInput[];
};

export async function requestReturnCase(db: Db, user: SessionUser, input: RequestCaseInput): Promise<{ id: string }> {
  if (input.reason === "OTHER" && !input.reasonNote?.trim()) throw new ReturnCaseError("Say what the reason is.");
  if (input.type === "EXCHANGE" && !input.courierChargeBearer) throw new ReturnCaseError("Say who pays the courier for the replacement.");
  return withTx(db, async (tx) => {
    const order = await loadOrder(tx, input.orderId);
    assertReturnable(order);
    if (input.type === "EXCHANGE" && !order.customerId) throw new ReturnCaseError("An anonymous walk-in sale has no one to ship a replacement to — exchange it at the counter.");
    validateLines(order, input.lines, await returnableQtyByItem(tx, order));
    if (input.type === "EXCHANGE") await lockReplacements(tx, order, input.lines);

    const created = await tx.returnCase.create({
      data: {
        type: input.type,
        mode: "ONLINE",
        status: "REQUESTED",
        orderId: order.id,
        reason: input.reason,
        reasonNote: input.reasonNote?.trim() || null,
        courierChargeBearer: input.type === "EXCHANGE" ? input.courierChargeBearer : null,
        requestedById: user.id,
        lines: {
          create: input.lines.map((l) => ({ orderItemId: l.orderItemId, qty: l.qty, replacementVariantId: input.type === "EXCHANGE" ? l.replacementVariantId : null })),
        },
      },
      select: { id: true },
    });
    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: input.type === "EXCHANGE" ? "exchange.request" : "return.request",
      entityType: "order",
      entityId: order.id,
      after: { caseId: created.id, reason: input.reason, reasonNote: input.reasonNote ?? null, courierChargeBearer: input.courierChargeBearer ?? null, lines: input.lines },
    });
    return created;
  });
}

export type DecisionResult = {
  /** Orders whose total changed — their invoice is regenerated as a new version. */
  totalsChanged: string[];
  replacementOrderId: string | null;
  replacementOrderNo: string | null;
  /** What the customer is owed back on the original order after this (a refund to request). */
  owedToCustomer: string;
};

const CASE_WITH_LINES = {
  id: true,
  type: true,
  mode: true,
  status: true,
  orderId: true,
  reason: true,
  reasonNote: true,
  courierChargeBearer: true,
  requestedById: true,
  replacementOrderId: true,
  inspectionId: true,
  orderStatusBefore: true,
  lines: { select: { orderItemId: true, qty: true, replacementVariantId: true } },
} satisfies Prisma.ReturnCaseSelect;

export async function decideReturnCase(
  db: Db,
  user: SessionUser,
  caseId: string,
  input: { decision: "APPROVE" | "REJECT"; note?: string | null },
): Promise<DecisionResult | null> {
  return withTx(db, async (tx) => {
    const rc = await tx.returnCase.findUnique({ where: { id: caseId }, select: CASE_WITH_LINES });
    if (!rc) throw new ReturnCaseError("Return not found", 404);
    if (rc.status !== "REQUESTED") throw new ReturnCaseError("This request has already been decided.", 409);
    if (rc.requestedById === user.id) throw new ReturnCaseError("A return or exchange must be approved by someone other than who requested it.", 403);
    const note = input.note?.trim() || null;

    if (input.decision === "REJECT") {
      if (!note) throw new ReturnCaseError("Give a reason for rejecting it.");
      const { count } = await tx.returnCase.updateMany({ where: { id: rc.id, status: "REQUESTED" }, data: { status: "REJECTED", decidedById: user.id, decidedAt: new Date(), decisionNote: note } });
      if (count !== 1) throw new ReturnCaseError("This request has already been decided.", 409);
      await writeAuditLogWith(tx, {
        actorId: user.id,
        action: rc.type === "EXCHANGE" ? "exchange.reject" : "return.reject",
        entityType: "order",
        entityId: rc.orderId,
        before: { caseId: rc.id, status: "REQUESTED" },
        after: { caseId: rc.id, status: "REJECTED", note },
      });
      return null;
    }

    // Claim first: two approvers at once can't both set it up.
    const { count } = await tx.returnCase.updateMany({ where: { id: rc.id, status: "REQUESTED" }, data: { status: "APPROVED", decidedById: user.id, decidedAt: new Date(), decisionNote: note } });
    if (count !== 1) throw new ReturnCaseError("This request has already been decided.", 409);

    const order = await loadOrder(tx, rc.orderId);
    assertReturnable(order);
    validateLines(order, rc.lines, await returnableQtyByItem(tx, order, rc.id));
    const replacements = rc.type === "EXCHANGE" ? await lockReplacements(tx, order, rc.lines) : null;

    const valuePaisa = await applyReturnedUnits(tx, order, rc.lines, 1);
    const inspection = await openReturnInspection(tx, { orderId: order.id, source: rc.type === "EXCHANGE" ? "EXCHANGE" : "CUSTOMER_RETURN", lines: rc.lines });
    if (!inspection) throw new ReturnCaseError("Nothing to check on return.");

    let replacement: { id: string; orderNo: string } | null = null;
    let creditPaisa = 0;
    if (rc.type === "EXCHANGE") {
      replacement = await createOnlineReplacement(tx, { order, caseLines: rc.lines, replacements: replacements!, bearer: rc.courierChargeBearer!, reason: rc.reason, actorId: user.id });
      const { total } = await tx.order.findUniqueOrThrow({ where: { id: replacement.id }, select: { total: true } });
      creditPaisa = await transferExchangeCredit(tx, { caseId: rc.id, original: order, replacement: { ...replacement, total }, valuePaisa, actorId: user.id });
    }

    // The original order's status: an exchange puts it at EXCHANGE_REQUESTED
    // until the item is back; a return of everything the customer had makes
    // it RETURNED (a refund then makes it REFUNDED).
    const from = order.status as OrderStatusValue;
    let to: OrderStatusValue | null = null;
    if (rc.type === "EXCHANGE" && from !== "EXCHANGE_REQUESTED") to = "EXCHANGE_REQUESTED";
    if (rc.type === "RETURN") {
      const left = await tx.orderItem.findMany({ where: { orderId: order.id, unitCostSnapshot: { not: null } }, select: { qty: true, returnedQty: true } });
      if (left.every((i) => i.qty - i.returnedQty === 0) && isTransitionAllowed(from, "RETURNED")) to = "RETURNED";
    }
    if (to) await moveOrderStatus(tx, { id: order.id, status: from, items: [] }, to, user.id, `${rc.type === "EXCHANGE" ? "Exchange" : "Return"} approved — ${RETURN_REASON_LABELS[rc.reason]}`);

    await tx.returnCase.update({
      where: { id: rc.id },
      data: { inspectionId: inspection.id, replacementOrderId: replacement?.id ?? null, orderStatusBefore: to ? from : null },
    });

    const { dueAmount } = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { dueAmount: true } });
    const owed = Math.max(0, -toPaisa(dueAmount));
    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: rc.type === "EXCHANGE" ? "exchange.approve" : "return.approve",
      entityType: "order",
      entityId: order.id,
      before: { caseId: rc.id, status: "REQUESTED", orderStatus: from, total: order.total.toString() },
      after: {
        caseId: rc.id,
        status: "APPROVED",
        note,
        orderStatus: to ?? from,
        returnedValue: fromPaisa(valuePaisa),
        inspectionId: inspection.id,
        replacementOrderId: replacement?.id ?? null,
        exchangeCredit: fromPaisa(creditPaisa),
        owedToCustomer: fromPaisa(owed),
      },
    });

    return {
      totalsChanged: [order.id, ...(replacement ? [replacement.id] : [])],
      replacementOrderId: replacement?.id ?? null,
      replacementOrderNo: replacement?.orderNo ?? null,
      owedToCustomer: fromPaisa(owed),
    };
  });
}

/**
 * The linked order an online exchange ships through the normal
 * packing/courier flow: CONFIRMED, stock reserved (CLAUDE.md rule 10), same
 * customer, courier and zone, owned by the original's executive so it stays
 * in their scope. Delivery is charged to the customer only when they bear it.
 */
async function createOnlineReplacement(
  tx: Prisma.TransactionClient,
  input: {
    order: OrderForCase;
    caseLines: { orderItemId: string; qty: number; replacementVariantId: string | null }[];
    replacements: Map<string, ReplacementVariant>;
    bearer: CourierChargeBearerValue;
    reason: ReturnReasonValue;
    actorId: string;
  },
): Promise<{ id: string; orderNo: string }> {
  const { order } = input;
  const lines = input.caseLines.map((l) => {
    const item = order.items.find((i) => i.id === l.orderItemId)!;
    const variant = input.replacements.get(l.replacementVariantId!)!;
    return { variant, qty: l.qty, ...priceReplacement(item, l.qty, variant) };
  });
  const deliveryCharge = input.bearer === "CUSTOMER" ? toNumber(order.courierZone?.charge ?? order.deliveryCharge) : 0;
  const totals = computeOrderTotals(lines, deliveryCharge);
  const orderNo = await generateOrderNumber(tx);
  const replacement = await tx.order.create({
    data: {
      orderNo,
      channel: "ONLINE",
      status: "CONFIRMED",
      customerId: order.customerId,
      courierId: order.courierId,
      courierZoneId: order.courierZoneId,
      deliveryCharge,
      subtotal: round2(totals.subtotal),
      discountTotal: round2(totals.discountTotal),
      total: round2(totals.total),
      dueAmount: round2(totals.total),
      deliveryNote: order.deliveryNote,
      internalNote: `Exchange for ${order.orderNo} — ${RETURN_REASON_LABELS[input.reason]}`,
      createdById: order.createdById ?? input.actorId,
      teamId: order.teamId,
      exchangedFromOrderId: order.id,
    },
    select: { id: true, orderNo: true },
  });
  for (const line of lines) {
    await tx.orderItem.create({ data: { orderId: replacement.id, variantId: line.variant.id, qty: line.qty, unitPrice: line.unitPrice, lineDiscount: line.lineDiscount } });
    await reserveVariantStock(tx, line.variant.id, line.qty);
  }
  await tx.orderStatusHistory.create({
    data: { orderId: replacement.id, fromStatus: null, toStatus: "CONFIRMED", changedById: input.actorId, note: `Exchange replacement for ${order.orderNo}` },
  });
  return replacement;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * A request is withdrawn by whoever asked or an approver. An approved case
 * can be cancelled (approvers only) while its item hasn't been checked in and
 * — for an exchange — its replacement hasn't left with the courier: the
 * replacement is cancelled (its reservation released, or stock restocked if
 * packed), the credit taken back, the returned units unmarked, the check
 * withdrawn and the original put back at its old status.
 */
export async function cancelReturnCase(db: Db, user: SessionUser, caseId: string, input: { note: string; canApprove: boolean }): Promise<{ totalsChanged: string[] }> {
  const note = input.note.trim();
  if (!note) throw new ReturnCaseError("Say why it's being cancelled.");
  return withTx(db, async (tx) => {
    const rc = await tx.returnCase.findUnique({
      where: { id: caseId },
      select: { ...CASE_WITH_LINES, inspection: { select: { id: true, status: true } }, replacementOrder: { select: { id: true, status: true, orderNo: true } } },
    });
    if (!rc) throw new ReturnCaseError("Return not found", 404);
    if (rc.status === "REQUESTED") {
      if (rc.requestedById !== user.id && !input.canApprove) throw new ReturnCaseError("Only whoever asked, or an approver, can withdraw this request.", 403);
    } else if (rc.status === "APPROVED") {
      if (!input.canApprove) throw new ReturnCaseError("Only an approver can cancel an approved return or exchange.", 403);
      if (rc.inspection?.status === "COMPLETED") throw new ReturnCaseError("The item is already back and checked — this can't be cancelled.", 409);
      const replacementStatus = rc.replacementOrder?.status as OrderStatusValue | undefined;
      if (replacementStatus && !["LEAD", "CONFIRMED", "ON_HOLD", "PACKED"].includes(replacementStatus)) {
        throw new ReturnCaseError(`The replacement ${rc.replacementOrder!.orderNo} has already gone to the courier — it can't be cancelled now.`, 409);
      }
    } else {
      throw new ReturnCaseError("Only an open request or an approved return/exchange can be cancelled.", 409);
    }

    const { count } = await tx.returnCase.updateMany({
      where: { id: rc.id, status: rc.status },
      data: { status: "CANCELLED", cancelledById: user.id, cancelledAt: new Date(), cancelNote: note, inspectionId: null },
    });
    if (count !== 1) throw new ReturnCaseError("Someone else just changed this — reload and try again.", 409);

    const totalsChanged: string[] = [];
    if (rc.status === "APPROVED") {
      const order = await loadOrder(tx, rc.orderId);
      if (order.status === "REFUNDED") throw new ReturnCaseError("This order has already been refunded — the return can't be cancelled.", 409);

      if (rc.replacementOrder) {
        const replacement = await tx.order.findUniqueOrThrow({ where: { id: rc.replacementOrder.id }, select: { id: true, status: true } });
        await moveOrderStatus(tx, { id: replacement.id, status: replacement.status as OrderStatusValue, items: [] }, "CANCELLED", user.id, `Exchange cancelled: ${note}`);
        const credits = await tx.payment.findMany({ where: { returnCaseId: rc.id, kind: "EXCHANGE_CREDIT" }, select: { id: true, orderId: true, amount: true } });
        await tx.payment.deleteMany({ where: { id: { in: credits.map((c) => c.id) } } });
        await recomputeOrderDueAmount(tx, replacement.id);
        totalsChanged.push(replacement.id);
      }
      await applyReturnedUnits(tx, order, rc.lines, -1);
      totalsChanged.push(order.id);
      if (rc.inspectionId) await tx.returnInspection.delete({ where: { id: rc.inspectionId } });

      // Back to where approval found it, unless another open case still holds it there.
      const heldAt: OrderStatusValue = rc.type === "EXCHANGE" ? "EXCHANGE_REQUESTED" : "RETURNED";
      if (rc.orderStatusBefore && order.status === heldAt) {
        const stillOpen = await tx.returnCase.count({ where: { orderId: order.id, type: rc.type, status: "APPROVED" } });
        if (stillOpen === 0) await revertOrderStatus(tx, { orderId: order.id, from: heldAt, to: rc.orderStatusBefore as OrderStatusValue }, user.id, `${rc.type === "EXCHANGE" ? "Exchange" : "Return"} cancelled: ${note}`);
      }
    }

    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: rc.type === "EXCHANGE" ? "exchange.cancel" : "return.cancel",
      entityType: "order",
      entityId: rc.orderId,
      before: { caseId: rc.id, status: rc.status, inspectionId: rc.inspectionId, replacementOrderId: rc.replacementOrderId },
      after: { caseId: rc.id, status: "CANCELLED", note },
    });
    return { totalsChanged };
  });
}

// ---------------------------------------------------------------------------
// Counter exchange — at the showroom, settled on the spot
// ---------------------------------------------------------------------------

export type CounterLineInput = { orderItemId: string; qty: number; replacementVariantId: string; goodQty: number; damagedQty: number };

export type CounterTenderInput = { method: PosPaymentMethod; amount: number; tendered?: number | null; walletId?: string | null; transactionId?: string | null };

export type CounterExchangeInput = {
  orderId: string;
  reason: ReturnReasonValue;
  reasonNote?: string | null;
  lines: CounterLineInput[];
  /** Pays the difference when the replacement costs more — exactly. */
  tenders: CounterTenderInput[];
  /** How a cheaper replacement's difference goes back (a refund request, approved by a Manager/Admin). */
  refundMethod?: PosPaymentMethod | null;
};

export type CounterExchangeResult = {
  caseId: string;
  replacementOrderId: string;
  replacementOrderNo: string;
  /** Paid by the customer now. */
  paid: string;
  change: string;
  /** Owed back to the customer: a refund request waiting for approval. */
  refundRequested: string;
  restockedUnits: number;
  writtenOffUnits: number;
};

/**
 * PRD §4.11 B: the customer is at the counter with the item. In ONE
 * transaction: the item is inspected (Good → EXCHANGE_IN, Damaged →
 * DAMAGE_OUT at the frozen cost, through the one condition-check service),
 * the replacement leaves as EXCHANGE_OUT on a linked walk-in order that is
 * COMPLETED at once (no courier), the credit moves across, and the
 * difference is settled — the customer pays extra now, or a refund of the
 * rest is requested for approval (the P2.3 two-person rule).
 */
export async function createCounterExchange(db: Db, ctx: { user: SessionUser; cashWalletId: string }, input: CounterExchangeInput): Promise<CounterExchangeResult> {
  if (input.reason === "OTHER" && !input.reasonNote?.trim()) throw new ReturnCaseError("Say what the reason is.");
  for (const l of input.lines) {
    if (!Number.isInteger(l.goodQty) || !Number.isInteger(l.damagedQty) || l.goodQty < 0 || l.damagedQty < 0 || l.goodQty + l.damagedQty !== l.qty) {
      throw new ReturnCaseError("Mark every returned unit as Good or Damaged.");
    }
  }
  for (const t of input.tenders) {
    if (toPaisa(t.amount) <= 0) throw new ReturnCaseError("Each payment needs an amount.");
    if (t.method !== "CASH" && t.tendered != null) throw new ReturnCaseError("Only cash can be over-tendered for change.");
    if (t.method === "CASH" && t.tendered != null && toPaisa(t.tendered) < toPaisa(t.amount)) throw new ReturnCaseError("Cash handed over is less than the cash amount.");
  }

  return withTx(db, async (tx) => {
    const order = await loadOrder(tx, input.orderId);
    assertReturnable(order);
    validateLines(order, input.lines, await returnableQtyByItem(tx, order));
    const replacements = await lockReplacements(tx, order, input.lines);

    const priced = input.lines.map((l) => {
      const item = order.items.find((i) => i.id === l.orderItemId)!;
      const variant = replacements.get(l.replacementVariantId)!;
      return { line: l, item, variant, ...priceReplacement(item, l.qty, variant) };
    });
    const totals = computeOrderTotals(priced.map((p) => ({ qty: p.line.qty, unitPrice: p.unitPrice, lineDiscount: p.lineDiscount })), 0);
    const replacementTotalPaisa = toPaisa(totals.total);

    // The returned units come off the original first: the value that leaves
    // it is the customer's credit, and settles the difference. (All in this
    // transaction — any refusal below undoes it.)
    const valuePaisa = await applyReturnedUnits(tx, order, input.lines, 1);
    const extraPaisa = Math.max(0, replacementTotalPaisa - valuePaisa);
    const owedPaisa = Math.max(0, valuePaisa - replacementTotalPaisa);
    const settled = settleTenders(extraPaisa, input.tenders);
    if (settled.remainingPaisa > 0) throw new ReturnCaseError(`${formatBDT(fromPaisa(settled.remainingPaisa))} still to pay for the difference.`);
    if (settled.remainingPaisa < 0) throw new ReturnCaseError(`The payments are ${formatBDT(fromPaisa(-settled.remainingPaisa))} more than the difference — give the extra back as change.`);
    // Cash taken now needs today's drawer open (a refund pays out only once approved).
    const drawer = input.tenders.some((t) => t.method === "CASH") ? await lockOpenDrawerForSale(tx, ctx.cashWalletId) : null;

    const now = new Date();
    const rc = await tx.returnCase.create({
      data: {
        type: "EXCHANGE",
        mode: "COUNTER",
        status: "COMPLETED",
        orderId: order.id,
        reason: input.reason,
        reasonNote: input.reasonNote?.trim() || null,
        requestedById: ctx.user.id,
        decidedById: ctx.user.id,
        decidedAt: now,
        decisionNote: "Exchanged at the counter",
        completedAt: now,
        lines: { create: input.lines.map((l) => ({ orderItemId: l.orderItemId, qty: l.qty, replacementVariantId: l.replacementVariantId })) },
      },
      select: { id: true },
    });

    // The returned item, checked on the spot.
    const inspection = await openReturnInspection(tx, { orderId: order.id, source: "EXCHANGE", lines: input.lines });
    await tx.returnCase.update({ where: { id: rc.id }, data: { inspectionId: inspection!.id } });
    const check = await completeConditionCheck(
      tx,
      { inspectionId: inspection!.id, lines: input.lines.map((l) => ({ orderItemId: l.orderItemId, goodQty: l.goodQty, damagedQty: l.damagedQty })), note: "Checked at the counter" },
      ctx.user.id,
    );

    // The replacement: a walk-in order, completed now, stock out as EXCHANGE_OUT.
    const orderNo = await generateOrderNumber(tx);
    const replacement = await tx.order.create({
      data: {
        orderNo,
        channel: "WALK_IN",
        status: "COMPLETED",
        customerId: order.customerId,
        deliveryCharge: 0,
        subtotal: round2(totals.subtotal),
        discountTotal: round2(totals.discountTotal),
        total: round2(totals.total),
        dueAmount: round2(totals.total),
        internalNote: `Counter exchange for ${order.orderNo} — ${RETURN_REASON_LABELS[input.reason]}`,
        createdById: ctx.user.id,
        teamId: ctx.user.teamId,
        exchangedFromOrderId: order.id,
      },
      select: { id: true, orderNo: true, total: true },
    });
    for (const p of priced) {
      await tx.orderItem.create({
        data: { orderId: replacement.id, variantId: p.variant.id, qty: p.line.qty, unitPrice: p.unitPrice, lineDiscount: p.lineDiscount, unitCostSnapshot: p.variant.weightedAvgCost },
      });
      await recordStockMovement(tx, {
        variantId: p.variant.id,
        type: "EXCHANGE_OUT",
        qty: -p.line.qty,
        unitCost: p.variant.weightedAvgCost,
        referenceType: "ORDER",
        referenceId: replacement.id,
        actorId: ctx.user.id,
        note: `Counter exchange for ${order.orderNo}`,
      });
    }
    await tx.orderStatusHistory.create({
      data: { orderId: replacement.id, fromStatus: null, toStatus: "COMPLETED", changedById: ctx.user.id, note: `Counter exchange for ${order.orderNo} — settled at the counter` },
    });
    await tx.returnCase.update({ where: { id: rc.id }, data: { replacementOrderId: replacement.id } });

    await transferExchangeCredit(tx, { caseId: rc.id, original: order, replacement, valuePaisa, actorId: ctx.user.id });

    // The difference: paid now on the replacement…
    for (const t of input.tenders) {
      const change = t.method === "CASH" && t.tendered != null ? toPaisa(t.tendered) - toPaisa(t.amount) : 0;
      await tx.payment.create({
        data: {
          orderId: replacement.id,
          amount: t.amount,
          method: t.method,
          walletId: t.method === "CASH" ? ctx.cashWalletId : await resolvePaymentWalletId(tx, t.method, t.walletId),
          transactionId: t.transactionId || null,
          receivedById: ctx.user.id,
          verified: false,
          cashTendered: t.method === "CASH" && t.tendered != null ? t.tendered : null,
          note: change > 0 ? `Tendered ${formatBDT(t.tendered!)}, change ${formatBDT(fromPaisa(change))}` : null,
        },
      });
    }
    const replacementDue = await recomputeOrderDueAmount(tx, replacement.id);
    if (toPaisa(replacementDue) !== 0) throw new ReturnCaseError("The payments don't settle the difference.");

    // …or owed back: a refund on the original, waiting for a Manager/Admin.
    if (owedPaisa > 0) {
      const method = input.refundMethod ?? "CASH";
      const walletId = method === "CASH" ? ctx.cashWalletId : await resolvePaymentWalletId(tx, method, null);
      if (!walletId) throw new ReturnCaseError("No active wallet can pay out this refund method — pick another.");
      await tx.payment.create({
        data: {
          orderId: order.id,
          kind: "REFUND",
          amount: -fromPaisa(owedPaisa),
          method,
          walletId,
          receivedById: ctx.user.id,
          verified: false,
          refundReason: `Counter exchange: the replacement ${replacement.orderNo} costs ${formatBDT(fromPaisa(owedPaisa))} less`,
          refundStatus: "PENDING",
          returnCaseId: rc.id,
        },
      });
      await recomputeOrderDueAmount(tx, order.id);
    }

    await writeAuditLogWith(tx, {
      actorId: ctx.user.id,
      action: "exchange.counter",
      entityType: "order",
      entityId: order.id,
      after: {
        caseId: rc.id,
        reason: input.reason,
        reasonNote: input.reasonNote ?? null,
        lines: input.lines,
        replacementOrderId: replacement.id,
        replacementOrderNo: replacement.orderNo,
        returnedValue: fromPaisa(valuePaisa),
        replacementTotal: fromPaisa(replacementTotalPaisa),
        paid: fromPaisa(extraPaisa),
        refundRequested: fromPaisa(owedPaisa),
        drawerId: drawer?.id ?? null,
      },
    });

    return {
      caseId: rc.id,
      replacementOrderId: replacement.id,
      replacementOrderNo: replacement.orderNo,
      paid: fromPaisa(extraPaisa),
      change: fromPaisa(settled.changePaisa),
      refundRequested: fromPaisa(owedPaisa),
      restockedUnits: check.restockedUnits,
      writtenOffUnits: check.writtenOffUnits,
    };
  });
}

/** A reused TrxID or an order-number race, as a clear error. */
export function returnCaseConflict(error: unknown): ReturnCaseError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
    if (target.includes("orderNo")) return new ReturnCaseError("Could not generate a unique order number — please try again.", 409);
    return new ReturnCaseError("This transaction ID has already been used.", 409);
  }
  return null;
}
