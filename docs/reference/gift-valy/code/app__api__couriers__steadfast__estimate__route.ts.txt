import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, apiError } from "@/lib/authz";
import { courierZoneRate, orderWeightKg } from "@/lib/courier";
import { loadBomCatalog } from "@/lib/bom-db";
import {
  estimateCourierCost,
  type ZoneRate,
} from "@/lib/courier-constants";
import { DELIVERY_ZONES, type DeliveryZoneValue } from "@/lib/order-constants";
import { STEADFAST_COURIER_NAME } from "@/lib/steadfast-constants";

// Pre-fill for the "Send to Steadfast" dialog (CORRECTIONS Courier §1): per
// order, the BOM weight sum, the order's zone, and the zone-rate estimate the
// dialog recomputes live as the operator edits zone/weight. The estimate is a
// COST — this route is already courier.manage-gated (same as the send itself).
const bodySchema = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(500),
});

export async function POST(req: Request) {
  try {
    await requirePermission("courier.manage");
    const { orderIds } = bodySchema.parse(await req.json());

    const courier = await prisma.courier.findUnique({
      where: { name: STEADFAST_COURIER_NAME },
      select: { id: true },
    });

    // The full 3-zone rate table travels with the response so the dialog can
    // recompute estimates client-side without another round trip.
    const rates: ZoneRate[] = [];
    if (courier) {
      for (const zone of DELIVERY_ZONES) {
        const rate = await courierZoneRate(prisma, courier.id, zone);
        if (rate) rates.push(rate);
      }
    }
    const rateByZone = new Map(rates.map((r) => [r.zone, r]));

    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, deliveryZone: true },
    });

    const catalog = await loadBomCatalog(prisma);
    const rows = [];
    for (const o of orders) {
      const weightKg = await orderWeightKg(prisma, o.id, catalog);
      const zone = (o.deliveryZone as DeliveryZoneValue | null) ?? null;
      rows.push({
        orderId: o.id,
        zone,
        weightKg,
        estimatedCost: estimateCourierCost(
          zone ? rateByZone.get(zone) : null,
          weightKg
        ),
      });
    }

    return NextResponse.json({ rows, rates });
  } catch (e) {
    return apiError(e);
  }
}
