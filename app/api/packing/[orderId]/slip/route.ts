import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { generatePackingSlipPdf } from "@/lib/packing/slip";

// PRD §4.8 packing slip PDF. Generated fresh on every request from the
// order's current state (no packing_slips table, unlike invoices' versioned
// history) — the slip is a printable snapshot, not a legal document that
// needs old versions retained.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const guard = await requirePermission(["packing.view_queue", "packing.pack"]);
  if (!guard.ok) return guard.response;

  const { orderId } = await params;
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { orderNo: true, status: true },
  });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.status === "LEAD" || order.status === "CONFIRMED") {
    return NextResponse.json({ error: "This order hasn't been packed yet." }, { status: 400 });
  }

  const pdf = await generatePackingSlipPdf(orderId);
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${order.orderNo}-packing-slip.pdf"`,
    },
  });
}
