import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { formatBDT } from "@/lib/money";
import { createPaymentSchema, storeCreditPaymentSchema } from "@/lib/orders/payment-validation";
import { spendStoreCredit, StoreCreditError } from "@/lib/store-credit/ledger";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { resolvePaymentWalletId, WalletError } from "@/lib/wallets/service";

// PRD §4.10: multiple payments per order (advance, partial, COD collection,
// post-delivery settlement) on top of the one recorded at order creation.
// CLAUDE.md rule 1: due_amount is never accepted from the client —
// createPaymentSchema has no such field, and recomputeOrderDueAmount() is
// the only thing allowed to write it, inside the same transaction as the
// payment insert.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("payment.create");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const order = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true, customerId: true, status: true } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  // P3.2 — paying from the customer's store credit: its own path through the
  // ledger (lib/store-credit/ledger.ts). No wallet, no TrxID, nothing to verify.
  if (body && typeof body === "object" && (body as { method?: unknown }).method === "STORE_CREDIT") {
    const credit = storeCreditPaymentSchema.safeParse(body);
    if (!credit.success) return NextResponse.json({ error: credit.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    if (!order.customerId) return NextResponse.json({ error: "This sale has no customer, so there's no store credit to use." }, { status: 409 });
    if (order.status === "CANCELLED") return NextResponse.json({ error: "This order is cancelled." }, { status: 409 });
    try {
      const paymentId = await prisma.$transaction(async (tx) => {
        const { dueAmount } = await tx.order.findUniqueOrThrow({ where: { id }, select: { dueAmount: true } });
        const amountPaisa = Math.round(credit.data.amount * 100);
        if (amountPaisa > Math.round(Number(dueAmount) * 100)) throw new StoreCreditError(`Only ${formatBDT(dueAmount.toString())} is still due on this order.`, 409);
        const spent = await spendStoreCredit(tx, { customerId: order.customerId!, orderId: id, amountPaisa, actorId: guard.user.id, note: credit.data.note });
        return spent.paymentId;
      });
      await writeAuditLog({ actorId: guard.user.id, action: "payment.create", entityType: "order", entityId: id, after: { paymentId, amount: credit.data.amount.toFixed(2), method: "STORE_CREDIT" }, request });
      const detail = await loadOrderDetail(id);
      return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user), { status: 201 });
    } catch (error) {
      if (error instanceof StoreCreditError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { amount, method, walletId, transactionId, paidAt, note } = parsed.data;

  try {
    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          orderId: id,
          amount,
          method,
          walletId: await resolvePaymentWalletId(tx, method, walletId),
          transactionId: transactionId || null,
          paidAt: paidAt ?? new Date(),
          receivedById: guard.user.id,
          verified: false,
          note: note || null,
        },
      });
      await recomputeOrderDueAmount(tx, id);
      return created;
    });

    await writeAuditLog({
      actorId: guard.user.id,
      action: "payment.create",
      entityType: "order",
      entityId: id,
      after: { paymentId: payment.id, amount: payment.amount.toString(), method: payment.method, walletId: payment.walletId, transactionId: payment.transactionId },
      request,
    });

    const detail = await loadOrderDetail(id);
    return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user), { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "This transaction ID has already been used" }, { status: 409 });
    }
    if (error instanceof WalletError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
