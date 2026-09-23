import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { ensureSteadfastCourier } from "@/lib/courier/integration";
import { zodError } from "@/lib/courier/route-errors";
import { DELIVERY_ZONE_VALUES } from "@/lib/orders/constants";
import { prisma } from "@/lib/prisma";

// CORRECTIONS Courier §1 — the 3-zone courier COST table (what we pay the
// courier: base for the first kg + per extra kg). Cost data, so it needs
// courier.manage AND product.cost.view. Stored per courier; only Steadfast
// is shown.

export async function GET() {
  const guard = await requirePermission(["courier.manage", "product.cost.view"], "all");
  if (!guard.ok) return guard.response;
  const courier = await ensureSteadfastCourier(prisma);
  const rows = await prisma.courierCostRate.findMany({ where: { courierId: courier.id } });
  return NextResponse.json({
    courier,
    rates: DELIVERY_ZONE_VALUES.map((zone) => {
      const row = rows.find((r) => r.zone === zone);
      return { zone, baseRate: row?.baseRate.toString() ?? "0", perKgRate: row?.perKgRate.toString() ?? "0" };
    }),
  });
}

const money = z.coerce.number().min(0).max(100_000).multipleOf(0.01);
const bodySchema = z.object({
  rates: z
    .array(z.object({ zone: z.enum(DELIVERY_ZONE_VALUES), baseRate: money, perKgRate: money }))
    .min(1)
    .max(DELIVERY_ZONE_VALUES.length)
    .refine((rates) => new Set(rates.map((r) => r.zone)).size === rates.length, "Each zone may appear once"),
});

export async function PUT(request: NextRequest) {
  const guard = await requirePermission(["courier.manage", "product.cost.view"], "all");
  if (!guard.ok) return guard.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);

  const courier = await ensureSteadfastCourier(prisma);
  const before = await prisma.courierCostRate.findMany({ where: { courierId: courier.id } });
  await prisma.$transaction(
    parsed.data.rates.map((r) =>
      prisma.courierCostRate.upsert({
        where: { courierId_zone: { courierId: courier.id, zone: r.zone } },
        update: { baseRate: r.baseRate, perKgRate: r.perKgRate },
        create: { courierId: courier.id, zone: r.zone, baseRate: r.baseRate, perKgRate: r.perKgRate },
      }),
    ),
  );

  await writeAuditLog({
    actorId: guard.user.id,
    action: "courier.cost_rates.update",
    entityType: "courier_company",
    entityId: courier.id,
    before: before.map((r) => ({ zone: r.zone, baseRate: r.baseRate.toString(), perKgRate: r.perKgRate.toString() })),
    after: parsed.data.rates,
    request,
  });

  return NextResponse.json({ ok: true });
}
