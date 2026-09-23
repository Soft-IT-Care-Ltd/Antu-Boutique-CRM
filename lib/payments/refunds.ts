import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { toNumber } from "@/lib/money";
import type { PaymentMethodValue } from "@/lib/orders/constants";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { resolvePaymentWalletId } from "@/lib/wallets/service";

// PRD §4.10: "Refunds recorded as negative payments with a reason and
// approval." A refund is a `payments` row with kind REFUND and a negative
// amount (DB CHECK). It is requested (PENDING), then approved or rejected
// by someone else holding payment.refund_approve. Only an APPROVED refund
// counts toward due_amount (lib/orders/totals.ts COUNTED_PAYMENTS_WHERE) and
// the wallet balance (lib/wallets/ledger.ts).

export class RefundError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * What can still be refunded on an order: verified money received, less
 * refunds already approved or waiting for approval. Unverified payments
 * aren't refundable — the money may never have arrived.
 */
export async function refundableAmount(tx: Prisma.TransactionClient, orderId: string, excludePaymentId?: string): Promise<number> {
  const [received, refunds] = await Promise.all([
    tx.payment.aggregate({ where: { orderId, kind: "PAYMENT", verified: true }, _sum: { amount: true } }),
    tx.payment.aggregate({
      where: { orderId, kind: "REFUND", refundStatus: { in: ["PENDING", "APPROVED"] }, ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}) },
      _sum: { amount: true },
    }),
  ]);
  // refunds are stored negative
  return Number(fromPaisa(Math.max(0, toPaisa(received._sum.amount ?? 0) + toPaisa(refunds._sum.amount ?? 0))));
}

export type RefundRequestInput = {
  amount: number;
  method: Exclude<PaymentMethodValue, "COURIER_COD">;
  walletId?: string | null;
  transactionId?: string | null;
  paidAt?: Date;
  reason: string;
};

export async function requestRefund(tx: Prisma.TransactionClient, orderId: string, input: RefundRequestInput, actorId: string) {
  const walletId = await resolvePaymentWalletId(tx, input.method, input.walletId);
  if (!walletId) throw new RefundError("No active wallet can pay out this refund method — add one first.");

  const available = await refundableAmount(tx, orderId);
  if (toPaisa(input.amount) > toPaisa(available)) {
    throw new RefundError(`Only ৳${available} can be refunded on this order (verified payments less other refunds).`);
  }

  const refund = await tx.payment.create({
    data: {
      orderId,
      kind: "REFUND",
      amount: -input.amount,
      method: input.method,
      walletId,
      transactionId: input.transactionId || null,
      paidAt: input.paidAt ?? new Date(),
      receivedById: actorId,
      verified: false,
      refundReason: input.reason,
      refundStatus: "PENDING",
    },
  });
  await recomputeOrderDueAmount(tx, orderId);
  await writeAuditLogWith(tx, {
    actorId,
    action: "payment.refund.request",
    entityType: "order",
    entityId: orderId,
    after: { paymentId: refund.id, amount: -input.amount, method: input.method, walletId, reason: input.reason },
  });
  return refund;
}

export type RefundDecisionInput = { decision: "APPROVE" | "REJECT"; note?: string | null; transactionId?: string | null };

export async function decideRefund(tx: Prisma.TransactionClient, paymentId: string, input: RefundDecisionInput, actorId: string) {
  const refund = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!refund || refund.kind !== "REFUND") throw new RefundError("Refund not found", 404);
  if (refund.refundStatus !== "PENDING") throw new RefundError("This refund has already been decided.", 409);
  if (refund.receivedById === actorId) throw new RefundError("A refund must be approved or rejected by someone other than who requested it.", 403);
  if (input.decision === "REJECT" && !input.note?.trim()) throw new RefundError("Give a reason for rejecting the refund.");

  if (input.decision === "APPROVE") {
    const available = await refundableAmount(tx, refund.orderId, refund.id);
    if (toPaisa(-toNumber(refund.amount)) > toPaisa(available)) {
      throw new RefundError(`Only ৳${available} can still be refunded on this order — reject this one or ask for a smaller refund.`);
    }
  }

  // Guarded on PENDING, so two people deciding at once can't both win.
  const { count } = await tx.payment.updateMany({
    where: { id: paymentId, refundStatus: "PENDING" },
    data: {
      refundStatus: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
      decidedById: actorId,
      decidedAt: new Date(),
      decisionNote: input.note?.trim() || null,
      ...(input.decision === "APPROVE" && input.transactionId ? { transactionId: input.transactionId } : {}),
    },
  });
  if (count === 0) throw new RefundError("This refund has already been decided.", 409);

  const dueAmount = await recomputeOrderDueAmount(tx, refund.orderId);
  await writeAuditLogWith(tx, {
    actorId,
    action: input.decision === "APPROVE" ? "payment.refund.approve" : "payment.refund.reject",
    entityType: "order",
    entityId: refund.orderId,
    before: { paymentId, refundStatus: "PENDING", amount: toNumber(refund.amount) },
    after: { paymentId, refundStatus: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", note: input.note ?? null, dueAmount },
  });
  return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
}
