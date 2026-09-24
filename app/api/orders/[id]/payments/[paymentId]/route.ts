import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { updatePaymentSchema } from "@/lib/orders/payment-validation";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { resolvePaymentWalletId, WalletError } from "@/lib/wallets/service";

// P2.3: a refund is never edited or deleted here — it's approved or
// rejected (lib/payments/refunds.ts), so its history stays intact.
const REFUND_LOCKED = "Refunds can't be edited or deleted — reject it and request a new one if it's wrong.";
// P3.2 — the credit an exchange carried between two orders; it changes only with its exchange.
const CREDIT_LOCKED = "This is exchange credit — it changes only if the exchange is cancelled (Returns & Exchanges).";

async function loadOrderForPaymentMutation(orderId: string, paymentId: string, user: Parameters<typeof scopedWhere>[1]) {
  const order = await prisma.order.findFirst({ where: scopedWhere({ id: orderId, deletedAt: null }, user), select: { id: true } });
  if (!order) return { order: null, payment: null };
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, orderId } });
  return { order, payment };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const guard = await requirePermission("payment.edit");
  if (!guard.ok) return guard.response;

  const { id, paymentId } = await params;
  const { order, payment } = await loadOrderForPaymentMutation(id, paymentId, guard.user);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (payment.kind === "REFUND") return NextResponse.json({ error: REFUND_LOCKED }, { status: 409 });
  if (payment.kind === "EXCHANGE_CREDIT") return NextResponse.json({ error: CREDIT_LOCKED }, { status: 409 });

  // P2.2b: a payment created by reconciling a courier statement is part of
  // that statement's audit trail — it can't be edited or deleted by hand.
  const statementLine = await prisma.courierStatementLine.findUnique({ where: { paymentId }, select: { statement: { select: { reference: true } } } });
  if (statementLine) {
    return NextResponse.json(
      { error: `This payment settled courier statement ${statementLine.statement.reference} — change it from the COD reconciliation screen, not here.` },
      { status: 409 },
      );
  }

  const parsed = updatePaymentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { amount, method, walletId, transactionId, paidAt, note } = parsed.data;

  try {
    const after = await prisma.$transaction(async (tx) => {
      const nextMethod = method ?? payment.method;
      // A method change without a wallet re-picks the default for the new method.
      const nextWalletId = await resolvePaymentWalletId(tx, nextMethod, walletId ?? (method && method !== payment.method ? undefined : payment.walletId));
      const nextTransactionId = transactionId === undefined ? payment.transactionId : transactionId || null;
      // Verification vouches for these exact figures. Change one and the
      // payment goes back to the queue (and out of the wallet balance).
      const moneyChanged =
        (amount !== undefined && amount !== Number(payment.amount)) ||
        nextMethod !== payment.method ||
        nextWalletId !== payment.walletId ||
        nextTransactionId !== payment.transactionId;
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: {
          amount: amount === undefined ? undefined : amount,
          method: nextMethod,
          walletId: nextWalletId,
          transactionId: nextTransactionId,
          paidAt: paidAt === undefined ? undefined : paidAt,
          note: note === undefined ? undefined : note || null,
          ...(moneyChanged && payment.verified ? { verified: false, verifiedById: null, verifiedAt: null } : {}),
        },
      });
      // Only amount changes the total collected, but recomputing
      // unconditionally is cheap and keeps this route from ever having to
      // reason about which fields matter — CLAUDE.md rule 1's guarantee
      // lives entirely in recomputeOrderDueAmount, not in this branch.
      await recomputeOrderDueAmount(tx, id);
      return updated;
    });

    await writeAuditLog({
      actorId: guard.user.id,
      action: "payment.edit",
      entityType: "order",
      entityId: id,
      before: { paymentId, amount: payment.amount.toString(), method: payment.method, walletId: payment.walletId, transactionId: payment.transactionId, note: payment.note, verified: payment.verified },
      after: { paymentId, amount: after.amount.toString(), method: after.method, walletId: after.walletId, transactionId: after.transactionId, note: after.note, verified: after.verified },
      request,
    });

    const detail = await loadOrderDetail(id);
    return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "This transaction ID has already been used" }, { status: 409 });
    }
    if (error instanceof WalletError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const guard = await requirePermission("payment.delete");
  if (!guard.ok) return guard.response;

  const { id, paymentId } = await params;
  const { order, payment } = await loadOrderForPaymentMutation(id, paymentId, guard.user);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (payment.kind === "REFUND") return NextResponse.json({ error: REFUND_LOCKED }, { status: 409 });
  if (payment.kind === "EXCHANGE_CREDIT") return NextResponse.json({ error: CREDIT_LOCKED }, { status: 409 });

  // P2.2b: a payment created by reconciling a courier statement is part of
  // that statement's audit trail — it can't be edited or deleted by hand.
  const statementLine = await prisma.courierStatementLine.findUnique({ where: { paymentId }, select: { statement: { select: { reference: true } } } });
  if (statementLine) {
    return NextResponse.json(
      { error: `This payment settled courier statement ${statementLine.statement.reference} — change it from the COD reconciliation screen, not here.` },
      { status: 409 },
      );
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: paymentId } });
    await recomputeOrderDueAmount(tx, id);
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "payment.delete",
    entityType: "order",
    entityId: id,
    before: {
      paymentId,
      amount: payment.amount.toString(),
      method: payment.method,
      walletId: payment.walletId,
      transactionId: payment.transactionId,
      verified: payment.verified,
      note: payment.note,
    },
    request,
  });

  const detail = await loadOrderDetail(id);
  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
}
