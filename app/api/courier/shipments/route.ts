import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { COURIER_SHIPMENT_TABS } from "@/lib/courier/constants";
import { canSeeOrderMoney, countShipmentTabs, listReadyToShip, listShipments } from "@/lib/courier/queries";
import { zodError } from "@/lib/courier/route-errors";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { paginationQuery } from "@/lib/list/pagination";

const COURIER_VIEW_PERMISSIONS: PermissionKey[] = ["courier.view", "courier.create_shipment", "courier.reconcile", "courier.manage", "courier.return_check"];

const querySchema = z.object({
  tab: z.enum(COURIER_SHIPMENT_TABS).default("ready"),
  q: z.string().trim().max(100).optional(),
  ...paginationQuery,
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(COURIER_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return zodError(parsed.error.issues);
  const { tab, ...opts } = parsed.data;

  const showMoney = await canSeeOrderMoney(guard.user);
  const [list, counts] = await Promise.all([
    tab === "ready" ? listReadyToShip(guard.user, opts, showMoney) : listShipments(guard.user, tab, opts, showMoney),
    countShipmentTabs(guard.user),
  ]);
  return NextResponse.json(await stripCostFieldsForUser({ tab, ...list, counts }, guard.user));
}
