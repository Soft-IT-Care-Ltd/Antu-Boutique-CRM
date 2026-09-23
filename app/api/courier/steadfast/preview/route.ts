import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { canSeeOrderMoney } from "@/lib/courier/queries";
import { zodError } from "@/lib/courier/route-errors";
import { previewSteadfastSend } from "@/lib/courier/send";
import { prisma } from "@/lib/prisma";

// The "Send to Steadfast" confirm dialog: per order, exactly what would be
// sent and anything blocking it — before a single consignment is booked.
const bodySchema = z.object({ orderIds: z.array(z.string().cuid()).min(1).max(500) });

export async function POST(request: NextRequest) {
  const guard = await requirePermission("courier.create_shipment");
  if (!guard.ok) return guard.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);

  const [rows, showMoney] = await Promise.all([previewSteadfastSend(prisma, parsed.data.orderIds, guard.user), canSeeOrderMoney(guard.user)]);
  const visible = showMoney
    ? rows
    : rows.map((row) => {
        const copy = { ...row };
        delete copy.codAmount;
        return copy;
      });
  return NextResponse.json(await stripCostFieldsForUser({ rows: visible }, guard.user));
}
