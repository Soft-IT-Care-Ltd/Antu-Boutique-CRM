import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { paginationQuery } from "@/lib/list/pagination";
import { prisma } from "@/lib/prisma";
import { STOCK_COUNT_SCOPES, STOCK_COUNT_STATUSES } from "@/lib/stock-counts/constants";
import { createStockCount, listStockCounts } from "@/lib/stock-counts/service";
import { stockDocumentErrorResponse } from "@/lib/transfers/http";

// C4 — CORRECTIONS.md item 2, stock count by scan. Scoped to the person's
// locations (location.all: every one).

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");

const querySchema = z.object({
  status: z.enum(STOCK_COUNT_STATUSES).optional(),
  locationId: z.string().trim().max(50).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  ...paginationQuery,
});

const createSchema = z.object({
  locationId: z.string().trim().min(1, "Pick a location").max(50),
  scope: z.enum(STOCK_COUNT_SCOPES).default("SPOT"),
  note: z.string().trim().max(500).nullish(),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["stock.count", "inventory.adjust"]);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const { from, to, locationId, ...rest } = parsed.data;
  const result = await listStockCounts(prisma, guard.user, {
    ...rest,
    locationId: locationId || undefined,
    from: from ? dhakaDayStartUtc(from) : undefined,
    to: to ? dhakaDayStartUtc(to, 1) : undefined,
  });
  return NextResponse.json({ ...result, page: rest.page, pageSize: rest.pageSize });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("stock.count");
  if (!guard.ok) return guard.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  try {
    const count = await prisma.$transaction((tx) => createStockCount(tx, guard.user, parsed.data));
    return NextResponse.json({ count }, { status: 201 });
  } catch (err) {
    const res = stockDocumentErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
