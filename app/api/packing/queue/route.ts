import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { loadPackingQueuePage, serializePackingQueueItem } from "@/lib/packing/queue";
import { getPackingSlaHours } from "@/lib/settings/get";

const querySchema = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// PRD §4.8: "packing queue — all CONFIRMED orders, oldest first." No money
// field exists anywhere in this response — see the comment on
// lib/packing/queue.ts's packingOrderInclude.
export async function GET(request: NextRequest) {
  const guard = await requirePermission("packing.view_queue");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }

  const [{ total, orders }, slaHours] = await Promise.all([
    loadPackingQueuePage(parsed.data),
    getPackingSlaHours(),
  ]);

  return NextResponse.json({
    items: orders.map((order) => serializePackingQueueItem(order, slaHours)),
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    slaHours,
  });
}
