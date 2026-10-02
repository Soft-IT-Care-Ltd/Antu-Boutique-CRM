import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { applyFulfilmentAction, FulfilmentError, fulfilmentActionSchema } from "@/lib/fulfilment/actions";
import { canViewOrder } from "@/lib/orders/access";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { prisma } from "@/lib/prisma";

// C5 — CORRECTIONS.md item 12: substitute, wait, remove an item, or cancel
// for a stock-out (order.fulfilment, on an order the person can see — the
// packing team sees every order's lines, never its money). The response
// carries no money: the caller reloads the order through its own route.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("order.fulfilment");
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const order = await prisma.order.findFirst({ where: { id, deletedAt: null }, select: { id: true, createdById: true, teamId: true } });
  if (!order || !(await canViewOrder(guard.user, order))) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const parsed = fulfilmentActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });

  try {
    const result = await applyFulfilmentAction(prisma, guard.user, id, parsed.data, { request });
    // Invariant 8: the order changed, so its invoice gets a new version (best
    // effort — the action stands even if Chromium is unavailable right now).
    try {
      await generateOrderInvoice(id, guard.user.id);
    } catch (invoiceError) {
      console.error(`Failed to regenerate the invoice after a fulfilment action on ${id}:`, invoiceError);
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfilmentError) return NextResponse.json({ error: error.message, ...error.body }, { status: error.status });
    throw error;
  }
}
