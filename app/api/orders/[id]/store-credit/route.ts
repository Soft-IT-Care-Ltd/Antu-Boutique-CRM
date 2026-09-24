import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { prisma } from "@/lib/prisma";
import { fromPaisa } from "@/lib/inventory/costing";
import { restoreStoreCreditForOrder } from "@/lib/store-credit/ledger";

// P3.2 — "Give back to store credit": undoes store credit spent on this
// order by mistake. Store credit payment rows are never edited or deleted
// (the customer's ledger), so the use is reversed with a RESTORED row.
// Cancelling the order does the same automatically (lib/orders/lifecycle.ts).
const schema = z.object({ reason: z.string().trim().min(3, "Say why it's being given back").max(300) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("payment.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const order = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });

  const restored = await prisma.$transaction((tx) => restoreStoreCreditForOrder(tx, { orderId: id, actorId: guard.user.id, reason: `Given back to store credit: ${parsed.data.reason}` }));
  if (restored === 0) return NextResponse.json({ error: "No store credit was used on this order." }, { status: 409 });
  await writeAuditLog({ actorId: guard.user.id, action: "payment.store_credit.restore", entityType: "order", entityId: id, after: { amount: fromPaisa(restored), reason: parsed.data.reason }, request });
  const detail = await loadOrderDetail(id);
  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
}
