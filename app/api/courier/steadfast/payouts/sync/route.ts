import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { runSteadfastPayoutsSync } from "@/lib/courier/payouts/sync";
import { courierErrorResponse } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";

// "Sync payouts" on the COD tab — the hourly payouts poll on demand.
export async function POST(request: NextRequest) {
  const guard = await requirePermission(["courier.reconcile", "courier.manage"]);
  if (!guard.ok) return guard.response;
  try {
    const summary = await runSteadfastPayoutsSync(prisma, { actorId: guard.user.id });
    await writeAuditLog({
      actorId: guard.user.id,
      action: "courier.steadfast.payouts_sync",
      entityType: "courier_integration",
      entityId: "steadfast",
      after: { payouts: summary.payouts, settled: summary.settled, discrepancies: summary.discrepancies, errors: summary.errors.length },
      request,
    });
    return NextResponse.json(summary);
  } catch (error) {
    return courierErrorResponse(error);
  }
}
