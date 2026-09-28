import { NextResponse, type NextRequest } from "next/server";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { requirePermission } from "@/lib/auth/require-permission";
import { orderFiltersSchema, orderTabCounts } from "@/lib/orders/list-query";

// CORRECTIONS.md item 14 — the count on every Orders tab, under the same
// filters and scope as the list itself (lib/orders/list-query.ts).

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

export async function GET(request: NextRequest) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = orderFiltersSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  return NextResponse.json(await orderTabCounts(parsed.data, guard.user));
}
