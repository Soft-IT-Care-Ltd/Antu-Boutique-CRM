import "server-only";

import type { Prisma } from "@prisma/client";

import { toNumber } from "@/lib/money";

// CLAUDE.md rule 1: order.due_amount is always recomputed from total minus
// sum(payments) server-side — this file is the only place allowed to
// produce a due_amount, and every caller must persist exactly what it
// returns. Never accept a client-sent value for any of these fields.

export type OrderLineInput = {
  qty: number;
  unitPrice: number;
  lineDiscount: number;
};

export type OrderTotals = {
  subtotal: number;
  discountTotal: number;
  total: number;
};

export function computeOrderTotals(items: OrderLineInput[], deliveryCharge: number): OrderTotals {
  let subtotal = 0;
  let discountTotal = 0;
  for (const item of items) {
    subtotal += item.qty * item.unitPrice;
    discountTotal += item.lineDiscount;
  }
  const total = subtotal - discountTotal + deliveryCharge;
  return { subtotal, discountTotal, total };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * P2.2 partial delivery: a line's money on the quantity the customer KEPT
 * (qty − returnedQty), with the line discount pro-rated to it. The one
 * formula behind the recomputed order total, the order screen's line totals
 * and the regenerated invoice — so they always add up to the same figure.
 * With nothing returned it is exactly qty × unitPrice − lineDiscount.
 */
export function keptLine(item: { qty: number; returnedQty: number; unitPrice: number; lineDiscount: number }): OrderLineInput & { lineTotal: number } {
  const kept = Math.max(0, item.qty - item.returnedQty);
  const lineDiscount = item.returnedQty === 0 || item.qty === 0 ? item.lineDiscount : round2((item.lineDiscount * kept) / item.qty);
  return { qty: kept, unitPrice: item.unitPrice, lineDiscount, lineTotal: round2(kept * item.unitPrice - lineDiscount) };
}

// Deliberately not clamped at 0 — a negative due amount means the customer
// has overpaid (a credit), which Accounts still needs to see, not a number
// that silently disappears to zero.
export function computeDueAmount(total: number, paidSoFar: number): number {
  return total - paidSoFar;
}

/**
 * The payments that count toward what the customer has paid: every PAYMENT,
 * plus refunds only once APPROVED (a refund is a negative row). A pending
 * or rejected refund moves no money, so it can't move due_amount either.
 * P3.2: an exchange credit counts on both orders — negative on the original
 * (its returned items' value left it), positive on the replacement.
 */
export const COUNTED_PAYMENTS_WHERE = {
  OR: [{ kind: "PAYMENT" }, { kind: "REFUND", refundStatus: "APPROVED" }, { kind: "EXCHANGE_CREDIT" }],
} satisfies Prisma.PaymentWhereInput;

// The one write path every payment create/update/delete route must call,
// inside the same transaction as its own write. Sums `payments` fresh from
// the DB rather than trusting anything the caller passed in, so a
// client-sent due_amount (PRD §4.10 / CLAUDE.md rule 1) never has anywhere
// to get in — this function is the sole source of the new value.
export async function recomputeOrderDueAmount(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const [order, paidAgg] = await Promise.all([
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
    tx.payment.aggregate({ where: { orderId, ...COUNTED_PAYMENTS_WHERE }, _sum: { amount: true } }),
  ]);
  const dueAmount = computeDueAmount(toNumber(order.total), toNumber(paidAgg._sum.amount ?? 0));
  await tx.order.update({ where: { id: orderId }, data: { dueAmount } });
  return dueAmount;
}
