import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { DELIVERY_ZONE_VALUES } from "@/lib/orders/constants";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { sendOrdersToSteadfast } from "@/lib/courier/send";
import { prisma } from "@/lib/prisma";

// Send PACKED orders to Steadfast — one or many (STEADFAST_INTEGRATION.md
// §2). Each successful order writes its own audit row inside its booking
// transaction (lib/courier/send.ts). `overrides` carries the dialog's
// zone + weight for the courier cost estimate.
const bodySchema = z.object({
  orderIds: z.array(z.string().cuid()).min(1).max(500),
  overrides: z
    .array(
      z.object({
        orderId: z.string().cuid(),
        zone: z.enum(DELIVERY_ZONE_VALUES).nullable().optional(),
        weightGrams: z.coerce.number().int().min(0).max(100_000).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requirePermission("courier.create_shipment");
  if (!guard.ok) return guard.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);

  try {
    const results = await sendOrdersToSteadfast(prisma, parsed.data, guard.user);
    return NextResponse.json({ results });
  } catch (error) {
    return courierErrorResponse(error);
  }
}
