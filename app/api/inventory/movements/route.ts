import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { dhakaDayStartUtc, STOCK_MOVEMENT_TYPES } from "@/lib/inventory/constants";
import { LEDGER_VIEW_PERMISSIONS, listStockMovements } from "@/lib/inventory/queries";
import { paginationQuery } from "@/lib/list/pagination";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  variantId: z.string().trim().max(50).optional(),
  locationId: z.string().trim().max(50).optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  ...paginationQuery,
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(LEDGER_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { from, to, q, variantId, locationId, ...rest } = parsed.data;

  const result = await listStockMovements({
    ...rest,
    q: q || undefined,
    variantId: variantId || undefined,
    locationId: locationId || undefined,
    from: from ? dhakaDayStartUtc(from) : undefined,
    to: to ? dhakaDayStartUtc(to, 1) : undefined,
  });
  return NextResponse.json(await stripCostFieldsForUser({ ...result, page: rest.page, pageSize: rest.pageSize }, guard.user));
}
