import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { refundDecisionSchema } from "@/lib/orders/payment-validation";
import { prisma } from "@/lib/prisma";
import { decideRefund } from "@/lib/payments/refunds";

// A second person (payment.refund_approve — Manager/Admin) approves or
// rejects a pending refund. Only then does it move due_amount and the wallet.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("payment.refund_approve");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const refund = await prisma.payment.findFirst({ where: { id, kind: "REFUND", order: scopedWhere({ deletedAt: null }, guard.user) }, select: { id: true, orderId: true } });
  if (!refund) return NextResponse.json({ error: "Refund not found" }, { status: 404 });
  const parsed = refundDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const decided = await prisma.$transaction((tx) => decideRefund(tx, id, parsed.data, guard.user.id));
    // The order screen swaps in the refreshed order (due amount moved on approval).
    const detail = await loadOrderDetail(refund.orderId);
    return NextResponse.json(await stripCostFieldsForUser({ refund: { id: decided.id, refundStatus: decided.refundStatus }, order: serializeOrderDetail(detail!) }, guard.user));
  } catch (error) {
    return financeErrorResponse(error);
  }
}
