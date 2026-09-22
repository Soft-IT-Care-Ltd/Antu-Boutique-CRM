import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { loadPackingOrder, serializePackingOrderDetail } from "@/lib/packing/queue";
import { getPackingSlaHours } from "@/lib/settings/get";

// Any non-deleted order regardless of status — the packing detail screen
// also serves as the reprint/history view for an order already PACKED.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const guard = await requirePermission("packing.view_queue");
  if (!guard.ok) return guard.response;

  const { orderId } = await params;
  const loaded = await loadPackingOrder(orderId);
  if (!loaded) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const slaHours = await getPackingSlaHours();
  return NextResponse.json({ order: serializePackingOrderDetail(loaded, slaHours) });
}
