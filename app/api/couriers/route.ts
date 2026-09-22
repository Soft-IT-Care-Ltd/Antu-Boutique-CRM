import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import type { CourierCompanyOption } from "@/lib/orders/types";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

// Minimal read for the order form's courier + zone pickers (PRD §4.6
// section 4). The full courier module — Steadfast credentials, shipments,
// COD reconciliation — is P2.2; this only ever reads the name/zone/charge
// columns that already exist on CourierCompany/CourierZone.
const VIEW_PERMISSIONS: PermissionKey[] = ["order.create", "order.view_own", "order.view_team", "order.view_all"];

export async function GET() {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const couriers = await prisma.courierCompany.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    include: { zones: { orderBy: { zone: "asc" } } },
  });

  const items: CourierCompanyOption[] = couriers.map((courier) => ({
    id: courier.id,
    name: courier.name,
    zones: courier.zones.map((zone) => ({ id: zone.id, zone: zone.zone, charge: zone.charge.toString() })),
  }));

  return NextResponse.json({ couriers: items });
}
