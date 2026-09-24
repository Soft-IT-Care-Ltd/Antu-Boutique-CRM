import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { getOrderReturnInfo } from "@/lib/returns/queries";

// The order screen's Returns & exchanges card: its cases, the units that can
// still go back, and the exchange it came from. Scoped like the order itself.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const guard = await requirePermission(["order.view_own", "order.view_team", "order.view_all"]);
  if (!guard.ok) return guard.response;
  const { orderId } = await params;
  const info = await getOrderReturnInfo(prisma, guard.user, orderId);
  if (!info) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  return NextResponse.json({ info });
}
