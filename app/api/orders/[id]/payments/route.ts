import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { createPaymentSchema } from "@/lib/orders/payment-validation";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";

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
  const order = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const parsed = createPaymentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { amount, method, wallet, transactionId, paidAt, note } = parsed.data;

  try {
    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          orderId: id,
          amount,
          method,
          wallet: wallet || null,
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
      after: { paymentId: payment.id, amount: payment.amount.toString(), method: payment.method },
      request,
    });

    const detail = await loadOrderDetail(id);
    return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user), { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "This transaction ID has already been used" }, { status: 409 });
    }
    throw error;
  }
}
