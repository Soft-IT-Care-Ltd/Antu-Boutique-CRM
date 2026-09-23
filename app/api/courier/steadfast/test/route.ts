import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { testSteadfastConnection } from "@/lib/courier/connection";
import { prisma } from "@/lib/prisma";

// "Test Connection" — GET /get_balance with the stored keys. Wrong keys come
// back as { ok: false, error } (HTTP 200), never a crash.
export async function POST() {
  const guard = await requirePermission("courier.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json(await testSteadfastConnection(prisma, guard.user.id));
}
