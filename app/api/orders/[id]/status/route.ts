import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { COURIER_OWNED_STATUSES, IllegalTransitionError, moveOrderStatus, STATUSES_REQUIRING_DEDICATED_FLOW } from "@/lib/orders/lifecycle";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { ORDER_STATUS_VALUES } from "@/lib/orders/constants";
import type { OrderStatusValue } from "@/lib/orders/constants";

const statusUpdateSchema = z.object({
  toStatus: z.enum(ORDER_STATUS_VALUES),
  note: z.string().trim().max(500).optional(),
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
    },
  });
  if (!existing) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const parsed = statusUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { toStatus, note } = parsed.data;

  if (STATUSES_REQUIRING_DEDICATED_FLOW.includes(toStatus)) {
    return NextResponse.json(
      { error: `Moving an order to ${toStatus} goes through its own dedicated flow, not a plain status change.` },
      { status: 400 },
    );
  }

  // P2.2: once Steadfast has the parcel, the courier sync owns its journey —
  // a hand-picked IN_TRANSIT/DELIVERED/RETURNED would drift from what
  // Steadfast reports.
  if (existing.shipment?.consignmentId && COURIER_OWNED_STATUSES.includes(toStatus)) {
    return NextResponse.json(
      { error: `This order is booked with Steadfast (consignment ${existing.shipment.consignmentId}) — its delivery status comes from the courier. Use "Sync now" on the Courier page.` },
      { status: 409 },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await moveOrderStatus(
        tx,
        { id: existing.id, status: existing.status as OrderStatusValue, items: existing.items },
        toStatus,
        guard.user.id,
        note,
      );
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
    action: "order.status_update",
    entityType: "order",
    entityId: id,
    before: { status: existing.status },
    after: { status: toStatus, note: note ?? null },
    request,
  });

  const detail = await loadOrderDetail(id);
  return NextResponse.json(await stripCostFieldsForUser({ order: serializeOrderDetail(detail!) }, guard.user));
}
