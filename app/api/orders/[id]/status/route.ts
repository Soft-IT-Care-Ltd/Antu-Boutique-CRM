import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { IllegalTransitionError, isDedicatedMove, moveOrderStatus } from "@/lib/orders/lifecycle";
import { decideCourierOverride } from "@/lib/orders/status-graph";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { ORDER_STATUS_VALUES } from "@/lib/orders/constants";
import { postExchangeCourierCost } from "@/lib/returns/exchange-courier-cost";
import type { OrderStatusValue } from "@/lib/orders/constants";

const statusUpdateSchema = z.object({
  toStatus: z.enum(ORDER_STATUS_VALUES),
  note: z.string().trim().max(500).optional(),
  // Required to move a Steadfast-booked order into a courier-owned status by
  // hand (order.courier_status_override, Admin only).
  courierOverrideReason: z.string().trim().min(10, "Give a reason of at least 10 characters for overriding the courier status").max(500).optional(),
});

// PRD §4.6 lifecycle + §6 rule "illegal transitions rejected server-side."
// See lib/orders/lifecycle.ts for the transition graph and why PACKED is
// deliberately excluded here (it belongs to P1.6's packing checklist,
// which deducts stock and freezes unit_cost_snapshot atomically with the
// status move — this generic route has no business doing either).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("order.status_update");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await prisma.order.findFirst({
    where: scopedWhere({ id, deletedAt: null }, guard.user),
    include: {
      items: { select: { variantId: true, qty: true, unitCostSnapshot: true } },
      shipment: { select: { consignmentId: true } },
      replacementFor: { select: { status: true } },
    },
  });
  if (!existing) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const parsed = statusUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { toStatus, note, courierOverrideReason } = parsed.data;

  if (isDedicatedMove(existing.status as OrderStatusValue, toStatus)) {
    const error =
      toStatus === "RETURNED" || toStatus === "EXCHANGE_REQUESTED"
        ? "A customer return or exchange goes through a request with a reason and a TL/Admin approval — use Return or Exchange on the order."
        : `Moving this order to ${toStatus} goes through its own dedicated flow, not a plain status change.`;
    return NextResponse.json({ error }, { status: 400 });
  }
  // P3.2 — a replacement order is cancelled by cancelling its exchange,
  // which also takes back the credit and the returned-item check.
  if (toStatus === "CANCELLED" && existing.replacementFor && existing.replacementFor.status !== "CANCELLED") {
    return NextResponse.json({ error: "This order is the replacement in an exchange — cancel the exchange instead (Returns & Exchanges)." }, { status: 409 });
  }

  // P2.2: once Steadfast has the parcel, the courier sync owns its journey —
  // a hand-picked IN_TRANSIT/DELIVERED/RETURNED would drift from what
  // Steadfast reports. The one exception is an Admin override with a
  // written reason (courier API down, parcel lost), audit-logged below.
  const decision = decideCourierOverride({
    consignmentId: existing.shipment?.consignmentId,
    toStatus,
    reason: courierOverrideReason,
    canOverride: await can(guard.user, "order.courier_status_override"),
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.error }, { status: decision.status });
  const isCourierOverride = decision.isOverride;

  try {
    await prisma.$transaction(async (tx) => {
      await moveOrderStatus(
        tx,
        { id: existing.id, status: existing.status as OrderStatusValue, items: existing.items },
        toStatus,
        guard.user.id,
        isCourierOverride ? `Courier status override: ${courierOverrideReason}${note ? ` · ${note}` : ""}` : note,
      );
      // A hand-set final status stops the poller from fighting it; a later
      // webhook with a different outcome still gets flagged (lib/courier/sync.ts).
      if (isCourierOverride && (toStatus === "DELIVERED" || toStatus === "RETURNED")) {
        await tx.shipment.update({ where: { orderId: existing.id }, data: { finalizedAt: new Date() } });
        // P3.2 — a company-borne exchange parcel's charge is final now.
        await postExchangeCourierCost(tx, existing.id, guard.user.id);
      }
      // CANCELLED after PACKED writes one RETURN_IN ledger row per line.
    }, { timeout: 30_000 });
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await writeAuditLog({
    actorId: guard.user.id,
    action: isCourierOverride ? "order.courier_status_override" : "order.status_update",
    entityType: "order",
    entityId: id,
    before: { status: existing.status },
    after: {
      status: toStatus,
      note: note ?? null,
      ...(isCourierOverride ? { courierOverrideReason, consignmentId: existing.shipment!.consignmentId } : {}),
    },
    request,
  });

  const detail = await loadOrderDetail(id);
  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
}
