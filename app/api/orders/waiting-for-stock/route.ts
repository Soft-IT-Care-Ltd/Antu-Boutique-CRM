import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { requirePermission } from "@/lib/auth/require-permission";
import { getWaitingForStock, waitingForStockCsv } from "@/lib/fulfilment/waiting";
import { todayInDhaka } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// C5 — CORRECTIONS.md item 12: the Waiting for stock list as JSON, or as CSV
// (?format=csv). Scoped like the Orders list (an executive: their own).

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];
const querySchema = z.object({ format: z.enum(["json", "csv"]).default("json") });

export async function GET(request: NextRequest) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query" }, { status: 400 });

  const data = await getWaitingForStock(prisma, guard.user);
  if (parsed.data.format === "csv") {
    return new NextResponse(waitingForStockCsv(data), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="waiting-for-stock-${todayInDhaka()}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  return NextResponse.json(data);
}
