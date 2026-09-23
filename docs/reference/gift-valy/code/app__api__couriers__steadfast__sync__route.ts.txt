import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, apiError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { runSteadfastPoll } from "@/lib/steadfast-sync";

// Manual "Sync now" (STEADFAST_INTEGRATION.md §3B) — the polling fallback on
// demand. Optional shipmentId drives the per-shipment refresh icon (ignores the
// polling interval). CORRECTIONS Orders §R1 — the order-list tab buttons pass
// `statuses` (scope to Handed to Courier / In Transit) + `force` (ignore the
// interval so the click always refreshes the whole tab). Requires courier.manage.
const bodySchema = z
  .object({
    shipmentId: z.number().int().positive().optional(),
    statuses: z
      .array(z.enum(["HANDED_TO_COURIER", "IN_TRANSIT"]))
      .min(1)
      .optional(),
    force: z.boolean().optional(),
  })
  .optional();

export async function POST(req: Request) {
  try {
    const session = await requirePermission("courier.manage");
    const body = bodySchema.parse(await req.json().catch(() => ({})));

    const summary = await runSteadfastPoll(
      body?.shipmentId
        ? { shipmentId: body.shipmentId }
        : body?.statuses
          ? { statuses: body.statuses, force: body.force }
          : undefined
    );

    await logAudit({
      userId: session.user.id,
      action: "courier_integration.sync",
      entity: "courier_integrations",
      after: summary,
    });

    return NextResponse.json(summary);
  } catch (e) {
    return apiError(e);
  }
}
