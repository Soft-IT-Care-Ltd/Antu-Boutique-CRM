import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { toNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import type { PaymentListItem, PaymentListQuery } from "@/lib/payments/types";

// PRD §4.10: "Accounts verifies payments; unverified payments show in an
// awaiting verification queue." Plus the refunds list. Every query is
// scoped through the order (CLAUDE.md rule 6) — today only roles with full
// visibility hold payment.view, but a per-user grant must not widen scope.

function orderScope(user: SessionUser): Prisma.OrderWhereInput {
  return scopedWhere({ deletedAt: null }, user) as Prisma.OrderWhereInput;
}

export function paymentListWhere(user: SessionUser, query: Omit<PaymentListQuery, "page" | "pageSize">): Prisma.PaymentWhereInput {
  const and: Prisma.PaymentWhereInput[] = [{ order: orderScope(user) }];
  switch (query.view) {
    case "unverified":
      // COD settled from a courier statement is verified by the statement itself.
      and.push({ kind: "PAYMENT", verified: false });
      break;
    case "verified":
      and.push({ kind: "PAYMENT", verified: true });
      break;
    case "refunds":
      and.push({ kind: "REFUND" });
      if (query.refundStatus) and.push({ refundStatus: query.refundStatus });
      break;
    default:
      break;
  }
  if (query.method) and.push({ method: query.method });
  if (query.walletId) and.push({ walletId: query.walletId });
  if (query.from) and.push({ paidAt: { gte: query.from } });
  if (query.to) and.push({ paidAt: { lt: query.to } });
  if (query.q) {
    and.push({
      OR: [
        { transactionId: { contains: query.q, mode: "insensitive" } },
        { order: { orderNo: { contains: query.q, mode: "insensitive" } } },
        { order: { customer: { phone: { contains: query.q } } } },
        { order: { customer: { name: { contains: query.q, mode: "insensitive" } } } },
      ],
    });
  }
  return { AND: and };
}

export async function listPayments(user: SessionUser, query: PaymentListQuery): Promise<{ items: PaymentListItem[]; total: number; totalAmount: string }> {
  const where = paymentListWhere(user, query);
  const [total, sum, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amount: true } }),
    prisma.payment.findMany({
      where,
      // The queue is worked oldest-first; history newest-first.
      orderBy: query.view === "unverified" ? [{ paidAt: "asc" }, { id: "asc" }] : [{ paidAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        wallet: { select: { name: true } },
        receivedBy: { select: { name: true } },
        verifiedBy: { select: { name: true } },
        decidedBy: { select: { name: true } },
        order: { select: { id: true, orderNo: true, status: true, total: true, dueAmount: true, customer: { select: { name: true, phone: true } } } },
      },
    }),
  ]);

  return {
    total,
    totalAmount: fromPaisa(toPaisa(sum._sum.amount ?? 0)),
    items: rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      amount: p.amount.toString(),
      method: p.method,
      walletId: p.walletId,
      walletName: p.wallet?.name ?? null,
      transactionId: p.transactionId,
      paidAt: p.paidAt.toISOString(),
      note: p.note,
      verified: p.verified,
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
      verifiedByName: p.verifiedBy?.name ?? null,
      receivedByName: p.receivedBy?.name ?? null,
      refundReason: p.refundReason,
      refundStatus: p.refundStatus,
      decidedByName: p.decidedBy?.name ?? null,
      decidedAt: p.decidedAt?.toISOString() ?? null,
      decisionNote: p.decisionNote,
      canDecide: p.kind === "REFUND" && p.refundStatus === "PENDING" && p.receivedById !== user.id,
      order: {
        id: p.order.id,
        orderNo: p.order.orderNo,
        status: p.order.status,
        total: p.order.total.toString(),
        dueAmount: p.order.dueAmount.toString(),
        customerName: p.order.customer.name,
        customerPhone: p.order.customer.phone,
      },
    })),
  };
}

/** Counts for the Payments tabs' badges. */
export async function paymentQueueCounts(user: SessionUser) {
  const scope = { order: orderScope(user) };
  const [unverified, unverifiedSum, pendingRefunds] = await Promise.all([
    prisma.payment.count({ where: { ...scope, kind: "PAYMENT", verified: false } }),
    prisma.payment.aggregate({ where: { ...scope, kind: "PAYMENT", verified: false }, _sum: { amount: true } }),
    prisma.payment.count({ where: { ...scope, kind: "REFUND", refundStatus: "PENDING" } }),
  ]);
  return { unverified, unverifiedAmount: fromPaisa(toPaisa(unverifiedSum._sum.amount ?? 0)), pendingRefunds };
}

/**
 * Verifies a batch from the queue. Only unverified PAYMENT rows in the
 * caller's scope are touched; each gets its own audit row. Returns how many
 * were verified (others were already verified, or out of scope).
 */
export async function verifyPayments(db: Db, user: SessionUser, paymentIds: string[]): Promise<number> {
  const rows = await db.payment.findMany({
    where: { id: { in: paymentIds }, kind: "PAYMENT", verified: false, order: orderScope(user) },
    select: { id: true, orderId: true, amount: true, method: true, walletId: true, transactionId: true },
  });
  if (rows.length === 0) return 0;
  const now = new Date();
  const { count } = await db.payment.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, verified: false },
    data: { verified: true, verifiedById: user.id, verifiedAt: now },
  });
  for (const r of rows) {
    await writeAuditLogWith(db, {
      actorId: user.id,
      action: "payment.verify",
      entityType: "order",
      entityId: r.orderId,
      before: { paymentId: r.id, verified: false },
      after: { paymentId: r.id, verified: true, amount: toNumber(r.amount), method: r.method, walletId: r.walletId, transactionId: r.transactionId },
    });
  }
  return count;
}
