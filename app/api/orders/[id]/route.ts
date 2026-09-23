import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { toNumber } from "@/lib/money";
import { applyValidatedOrderEdit, validateOrderEdit, type OrderEditInput } from "@/lib/orders/apply-edit";
import { editTouchesGatedFields, isWithinEditWindow } from "@/lib/orders/edit-window";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { getOrderEditWindowMinutes } from "@/lib/settings/get";
import { DIRECTLY_EDITABLE_STATUSES } from "@/lib/orders/constants";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import type { OrderStatusValue } from "@/lib/orders/constants";

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const scopedRow = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true } });
  if (!scopedRow) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const detail = await loadOrderDetail(id);
  if (!detail) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail) }, guard.user));
}

const orderItemSchema = z.object({
  variantId: z.string().cuid(),
  qty: z.coerce.number().int().min(1).max(9999),
  unitPrice: z.coerce.number().min(0),
  lineDiscount: z.coerce.number().min(0).default(0),
  stockOverrideReason: z.string().trim().max(300).optional(),
});

const updateOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1).max(50).optional(),
  courierId: z.string().cuid().nullish(),
  courierZoneId: z.string().cuid().nullish(),
  deliveryCharge: z.coerce.number().min(0).optional(),
  expectedDeliveryDate: z.coerce.date().nullish(),
  internalNote: z.string().trim().max(2000).nullish(),
  deliveryNote: z.string().trim().max(200).nullish(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("order.edit");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.order.findFirst({
    where: scopedWhere({ id, deletedAt: null }, guard.user),
    include: { items: true },
  });
  if (!existing) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  if (!DIRECTLY_EDITABLE_STATUSES.includes(existing.status as OrderStatusValue)) {
    return NextResponse.json({ error: "This order has moved past the stage where it can be edited directly" }, { status: 409 });
  }

  const parsed = updateOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const input: OrderEditInput = parsed.data;

  const validation = await validateOrderEdit(id, input, guard.user);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }

  // PRD §4.6 edit window: within N minutes of creation, an SE edits
  // directly, same as before. Past that, a change to items/price/discount/
  // delivery charge is queued for TL/Admin approval instead of applied —
  // unless the actor already holds the bypass permission (they ARE the
  // approver). Non-gated fields (courier, expected date, internal note)
  // never need approval, at any time.
  const windowMinutes = await getOrderEditWindowMinutes();
  const withinWindow = isWithinEditWindow(existing.createdAt, windowMinutes);
  const gated = editTouchesGatedFields(
    { items: existing.items.map((i) => ({ variantId: i.variantId, qty: i.qty, unitPrice: toNumber(i.unitPrice), lineDiscount: toNumber(i.lineDiscount) })), deliveryCharge: toNumber(existing.deliveryCharge) },
    { items: input.items, deliveryCharge: input.deliveryCharge },
  );
  const canBypassWindow = await can(guard.user, "order.edit_after_window");

  if (gated && !withinWindow && !canBypassWindow) {
    const alreadyPending = await prisma.orderEditRequest.findFirst({ where: { orderId: id, status: "PENDING" } });
    if (alreadyPending) {
      return NextResponse.json(
        { error: "This order already has an edit request awaiting Team Leader/Admin approval." },
        { status: 409 },
      );
    }

    const editRequest = await prisma.orderEditRequest.create({
      data: {
        orderId: id,
        status: "PENDING",
        proposedChanges: input as object,
        beforeSnapshot: existing as unknown as object,
        requestedById: guard.user.id,
      },
    });

    await writeAuditLog({
      actorId: guard.user.id,
      action: "order_edit_request.create",
      entityType: "order",
      entityId: id,
      after: editRequest,
      request,
    });

    return NextResponse.json(
      { pending: true, editRequestId: editRequest.id, message: "This order's edit window has passed — your change needs Team Leader/Admin approval before it applies." },
      { status: 202 },
    );
  }

  const updated = await applyValidatedOrderEdit(id, input, validation);

  if (gated) {
    try {
      await generateOrderInvoice(id, guard.user.id);
    } catch (invoiceError) {
      console.error(`Failed to regenerate invoice for order ${updated.orderNo}:`, invoiceError);
    }
  }

  await writeAuditLog({
    actorId: guard.user.id,
    action: "order.update",
    entityType: "order",
    entityId: id,
    before: { ...existing, items: undefined },
    after: updated,
    request,
  });

  const detail = await loadOrderDetail(id);
  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
}
