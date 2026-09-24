import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { loadReceiptOrder, renderReceiptPdf } from "@/lib/pos/receipt";
import { prisma } from "@/lib/prisma";

// P3.1 — the 80 mm thermal receipt for a walk-in sale, as a PDF sized to
// the paper (lib/pos/receipt.ts). Read-only: nothing is stored, so printing
// it again is always the same receipt. Anyone who can see the sale can
// print it — scoped like every order (an operator: their own sales).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["pos.sell", "order.view_own", "order.view_team", "order.view_all"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const visible = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null, channel: "WALK_IN" }, guard.user), select: { id: true } });
  const order = visible ? await loadReceiptOrder(prisma, visible.id) : null;
  if (!order) return NextResponse.json({ error: "Sale not found" }, { status: 404 });

  const pdf = await renderReceiptPdf(order);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${order.orderNo}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
