import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { getLowStockAlerts } from "@/lib/inventory/stock-report";

// PRD §4.2 — low-stock alerts per variant with a product-level roll-up.
export async function GET() {
  const guard = await requirePermission("inventory.view");
  if (!guard.ok) return guard.response;

  const alerts = await getLowStockAlerts();
  return NextResponse.json(await stripCostFieldsForUser({ alerts }, guard.user));
}
