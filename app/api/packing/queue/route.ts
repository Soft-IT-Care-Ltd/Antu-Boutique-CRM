import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { loadPackingQueuePage, serializePackingQueueItem } from "@/lib/packing/queue";
import { getPackingSlaHours } from "@/lib/settings/get";
import { PACKING_VIEWS } from "@/lib/packing/types";
import { paginationQuery } from "@/lib/list/pagination";

const querySchema = z.object({
  q: z.string().trim().optional(),
  view: z.enum(PACKING_VIEWS).default("queue"),
  ...paginationQuery,
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

  const slaHours = await getPackingSlaHours();
  const { total, orders } = await loadPackingQueuePage(parsed.data, slaHours);

  return NextResponse.json({
    items: orders.map((order) => serializePackingQueueItem(order, slaHours)),
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    slaHours,
  });
}
