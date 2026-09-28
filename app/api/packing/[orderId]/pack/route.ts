import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { LocationError } from "@/lib/locations/service";
import { IllegalTransitionError, PackStockError, packOrder } from "@/lib/orders/pack";
import { loadPackingOrder, serializePackingOrderDetail } from "@/lib/packing/queue";
import { getPackingSlaHours } from "@/lib/settings/get";
import type { OrderStatusValue } from "@/lib/orders/constants";

// PRD §4.8 checklist: items match, image matched, quality checked, invoice
// printed — every key must be exactly `true`. CLAUDE.md rule 9: the
// client's checklist UI is a convenience, never the guarantee, so a request
// missing or falsifying any key is rejected here before packOrder runs.
const checklistSchema = z.object({
  itemsMatch: z.literal(true),
  imageMatched: z.literal(true),
  qualityChecked: z.literal(true),
  invoicePrinted: z.literal(true),
});

const packSchema = z.object({
  checklist: checklistSchema,
  note: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const guard = await requirePermission("packing.pack");
  if (!guard.ok) return guard.response;

  const { orderId } = await params;
  const existing = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    include: { items: { select: { id: true, variantId: true, qty: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const parsed = packSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Complete the packing checklist first — all four items must be confirmed." }, { status: 400 });
  }
  const { checklist, note } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await packOrder(
        tx,
        { id: existing.id, status: existing.status as OrderStatusValue, items: existing.items },
        guard.user.id,
        note,
      );
      // Each line is a cost freeze + a SALE_OUT ledger write; give a big
      // order room over Prisma's 5s default.
    }, { timeout: 30_000 });
  } catch (error) {
    if (error instanceof IllegalTransitionError || error instanceof PackStockError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LocationError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  await writeAuditLog({
    actorId: guard.user.id,
    action: "order.pack",
    entityType: "order",
    entityId: orderId,
    before: { status: existing.status },
    after: { status: "PACKED", checklist, note: note ?? null },
    request,
  });

  const [detail, slaHours] = await Promise.all([loadPackingOrder(orderId), getPackingSlaHours()]);
  return NextResponse.json({ order: serializePackingOrderDetail(detail!, slaHours) });
}
