import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";

// PRD §4.10: "Accounts verifies payments; unverified payments show in an
// awaiting verification queue." Split from the generic PATCH so the two
// permissions (payment.edit vs payment.verify) stay independently
// grantable — verifying doesn't touch amount/method and never changes
// due_amount, so there's nothing for recomputeOrderDueAmount to do here.
const verifySchema = z.object({ verified: z.boolean().default(true) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const guard = await requirePermission("payment.verify");
  if (!guard.ok) return guard.response;

  const { id, paymentId } = await params;
  const order = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const payment = await prisma.payment.findFirst({ where: { id: paymentId, orderId: id } });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const parsed = verifySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { verified } = parsed.data;

  await prisma.payment.update({ where: { id: paymentId }, data: { verified } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: verified ? "payment.verify" : "payment.unverify",
    entityType: "order",
    entityId: id,
    before: { paymentId, verified: payment.verified },
    after: { paymentId, verified },
    request,
  });

  const detail = await loadOrderDetail(id);
  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
}
