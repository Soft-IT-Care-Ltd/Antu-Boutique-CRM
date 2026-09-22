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

// Deliberately not clamped at 0 — a negative due amount means the customer
// has overpaid (a credit), which Accounts still needs to see, not a number
// that silently disappears to zero.
export function computeDueAmount(total: number, paidSoFar: number): number {
  return total - paidSoFar;
}

// The one write path every payment create/update/delete route must call,
// inside the same transaction as its own write. Sums `payments` fresh from
// the DB rather than trusting anything the caller passed in, so a
// client-sent due_amount (PRD §4.10 / CLAUDE.md rule 1) never has anywhere
// to get in — this function is the sole source of the new value.
export async function recomputeOrderDueAmount(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const [order, paidAgg] = await Promise.all([
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
    tx.payment.aggregate({ where: { orderId }, _sum: { amount: true } }),
  ]);
  const dueAmount = computeDueAmount(toNumber(order.total), toNumber(paidAgg._sum.amount ?? 0));
  await tx.order.update({ where: { id: orderId }, data: { dueAmount } });
  return dueAmount;
}
