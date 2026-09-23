import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { createRefundSchema } from "@/lib/orders/payment-validation";
import { prisma } from "@/lib/prisma";
import { requestRefund } from "@/lib/payments/refunds";

// PRD §4.10: "Refunds recorded as negative payments with a reason and
// approval." This only requests it — see /api/payments/[id]/refund-decision.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("payment.refund");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const order = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const parsed = createRefundSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await prisma.$transaction((tx) => requestRefund(tx, id, parsed.data, guard.user.id));
    const detail = await loadOrderDetail(id);
    return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user), { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
