import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { getSetAvailabilityReport } from "@/lib/sets/service";

// PRD §4.2 (P3.3) — how many of each outfit set can be sold right now, and
// which component holds it down. Stock only, no cost.
export async function GET() {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ rows: await getSetAvailabilityReport(prisma) });
}
