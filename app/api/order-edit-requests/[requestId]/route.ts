import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { applyValidatedOrderEdit, OrderEditConflictError, parseStoredOrderEditInput, validateOrderEdit } from "@/lib/orders/apply-edit";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reviewNote: z.string().trim().max(500).optional(),
});

// PRD §4.6: "Approval applies the change and regenerates the invoice as a
// NEW VERSION, keeping old versions." Re-validates the proposed change
// against the order's CURRENT state (lib/orders/apply-edit.ts) rather than
// trusting what was true when the request was filed — stock or price-floor
// state can have moved while it sat PENDING.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const guard = await requirePermission("order.edit_after_window");
  if (!guard.ok) return guard.response;

  const { requestId } = await params;
  const editRequest = await prisma.orderEditRequest.findUnique({ where: { id: requestId } });
  if (!editRequest) return NextResponse.json({ error: "Edit request not found" }, { status: 404 });
  if (editRequest.status !== "PENDING") {
    return NextResponse.json({ error: "This request has already been reviewed" }, { status: 409 });
  }

  // Same visibility rule as everywhere else: a Team Leader may only act on
  // a request for an order inside their own team (CLAUDE.md rule 6).
  const scopedOrder = await prisma.order.findFirst({
    where: scopedWhere({ id: editRequest.orderId, deletedAt: null }, guard.user),
    select: { id: true },
  });
  if (!scopedOrder) return NextResponse.json({ error: "Edit request not found" }, { status: 404 });

  const parsed = reviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { action, reviewNote } = parsed.data;

  if (action === "reject") {
    const updated = await prisma.orderEditRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", reviewedById: guard.user.id, reviewedAt: new Date(), reviewNote: reviewNote || null },
    });
    await writeAuditLog({
      actorId: guard.user.id,
      action: "order_edit_request.reject",
      entityType: "order_edit_request",
      entityId: requestId,
      before: { status: "PENDING" },
      after: updated,
      request,
    });
    return NextResponse.json({ editRequest: updated });
  }

  const input = parseStoredOrderEditInput(editRequest.proposedChanges);
  const validation = await validateOrderEdit(editRequest.orderId, input, guard.user);
  if (!validation.ok) {
    return NextResponse.json(
      { error: `This request can no longer be applied as-is: ${validation.error}` },
      { status: validation.status },
    );
  }

  let updatedOrder;
  try {
    updatedOrder = await applyValidatedOrderEdit(editRequest.orderId, input, validation);
  } catch (error) {
    if (error instanceof OrderEditConflictError) {
      return NextResponse.json({ error: `This request can no longer be applied as-is: ${error.message}` }, { status: 409 });
    }
    throw error;
  }

  try {
    await generateOrderInvoice(editRequest.orderId, guard.user.id);
  } catch (invoiceError) {
    console.error(`Failed to regenerate invoice for order ${updatedOrder.orderNo}:`, invoiceError);
  }

  const updatedRequest = await prisma.orderEditRequest.update({
    where: { id: requestId },
    data: { status: "APPROVED", reviewedById: guard.user.id, reviewedAt: new Date(), reviewNote: reviewNote || null },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "order_edit_request.approve",
    entityType: "order_edit_request",
    entityId: requestId,
    before: editRequest.beforeSnapshot as object,
    after: { order: updatedOrder, editRequest: updatedRequest },
    request,
  });

  const detail = await loadOrderDetail(editRequest.orderId);
  return NextResponse.json({
    editRequest: updatedRequest,
    order: await stripCostFieldsForUser(serializeOrderDetail(detail!), guard.user),
  });
}
