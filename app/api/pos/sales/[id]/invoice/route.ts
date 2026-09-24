import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { orderUploadUrl } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";

// PRD §4.7 "prints/skips an invoice": a walk-in sale gets its invoice only
// when someone asks to print it — skipping costs nothing. Asking again
// returns the same version (the sale can't change after it completes).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("pos.sell");
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const order = await prisma.order.findFirst({
    where: scopedWhere({ id, deletedAt: null, channel: "WALK_IN" }, guard.user),
    select: { id: true, invoices: { orderBy: { version: "desc" }, take: 1, select: { filePath: true } } },
  });
  if (!order) return NextResponse.json({ error: "Sale not found" }, { status: 404 });

  const existing = order.invoices[0];
  if (existing) return NextResponse.json({ url: orderUploadUrl(existing.filePath) });
  try {
    const invoice = await generateOrderInvoice(order.id, guard.user.id);
    return NextResponse.json({ url: orderUploadUrl(invoice.filePath) }, { status: 201 });
  } catch (error) {
    console.error(`Failed to generate the POS invoice for order ${order.id}:`, error);
    return NextResponse.json({ error: "Could not make the invoice right now — the sale itself is saved. Try again." }, { status: 503 });
  }
}
