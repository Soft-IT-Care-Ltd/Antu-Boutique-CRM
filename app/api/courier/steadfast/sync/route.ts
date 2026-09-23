import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { runSteadfastPoll } from "@/lib/courier/poll";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";

// "Sync now" (all non-final shipments, ignoring the polling interval) and
// the per-shipment refresh icon (one shipmentId).
const bodySchema = z.object({ shipmentId: z.string().cuid().optional() });

export async function POST(request: NextRequest) {
  const guard = await requirePermission("courier.manage");
  if (!guard.ok) return guard.response;

  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return zodError(parsed.error.issues);

  try {
    const summary = await runSteadfastPoll(prisma, parsed.data.shipmentId ? { shipmentId: parsed.data.shipmentId } : { force: true });
    await writeAuditLog({
      actorId: guard.user.id,
      action: "courier.steadfast.sync",
      entityType: "courier_integration",
      entityId: parsed.data.shipmentId ?? "all",
      after: { polled: summary.polled, changed: summary.changed, errors: summary.errors.length },
      request,
    });
    return NextResponse.json(summary);
  } catch (error) {
    return courierErrorResponse(error);
  }
}
