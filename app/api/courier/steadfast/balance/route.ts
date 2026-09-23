import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { refreshSteadfastBalance } from "@/lib/courier/connection";
import { prisma } from "@/lib/prisma";

// Balance widget refresh — GET /get_balance. The balance only, never the keys.
export async function GET() {
  const guard = await requirePermission("courier.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json(await refreshSteadfastBalance(prisma));
}
