import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { STOCK_STATUS_FILTERS } from "@/lib/inventory/constants";
import { getStockReport } from "@/lib/inventory/stock-report";
import { paginationQuery } from "@/lib/list/pagination";

// PRD §4.15 R4 — stock per variant. Open to every inventory.view role; the
// valuation columns are stripped for anyone without product.cost.view.

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().trim().max(50).optional(),
  status: z.enum(STOCK_STATUS_FILTERS).default("all"),
  ...paginationQuery,
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("inventory.view");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }

  const report = await getStockReport({ ...parsed.data, q: parsed.data.q || undefined, categoryId: parsed.data.categoryId || undefined });
  return NextResponse.json(await stripCostFieldsForUser({ ...report, page: parsed.data.page, pageSize: parsed.data.pageSize }, guard.user));
}
