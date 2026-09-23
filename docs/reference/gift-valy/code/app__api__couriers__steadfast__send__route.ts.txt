import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, apiError, AuthzError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { getSteadfastIntegration } from "@/lib/steadfast-integration";
import {
  sendOrdersToSteadfast,
  type SendOrderOverride,
} from "@/lib/steadfast-send";

// "Send to Steadfast" from the Orders CONFIRMED and PACKED tabs
// (STEADFAST_INTEGRATION.md §2 + CORRECTIONS Orders §6j — confirmed orders
// auto-pack first). Single or multi-select. Requires courier.manage AND an
// enabled integration. `overrides` carries the send dialog's per-order zone +
// weight for the courier cost estimate (CORRECTIONS Courier §1).
const bodySchema = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(500),
  overrides: z
    .array(
      z.object({
        orderId: z.number().int().positive(),
        deliveryZone: z
          .enum(["INSIDE_DHAKA", "SUB_DHAKA", "OUTSIDE_DHAKA"])
          .nullable()
          .optional(),
        weightKg: z.number().min(0).nullable().optional(),
      })
    )
    .optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requirePermission("courier.manage");
    const { orderIds, overrides } = bodySchema.parse(await req.json());

    const integration = await getSteadfastIntegration();
    if (!integration || !integration.isEnabled) {
      throw new AuthzError(400, "Steadfast integration is not enabled");
    }

    const overrideMap: Record<number, SendOrderOverride> = {};
    for (const o of overrides ?? []) {
      overrideMap[o.orderId] = {
        deliveryZone: o.deliveryZone,
        weightKg: o.weightKg,
      };
    }

    const results = await sendOrdersToSteadfast(
      orderIds,
      integration,
      session.user.id,
      overrideMap
    );

    await logAudit({
      userId: session.user.id,
      action: "courier_integration.send",
      entity: "orders",
      after: {
        requested: orderIds.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      },
    });

    return NextResponse.json({ results });
  } catch (e) {
    return apiError(e);
  }
}
