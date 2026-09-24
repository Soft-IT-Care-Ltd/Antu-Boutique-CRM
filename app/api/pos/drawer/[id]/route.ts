import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { getDrawerSummary } from "@/lib/pos/drawer";
import { prisma } from "@/lib/prisma";

// One day's reconciliation: opening, every cash movement, expected, counted, difference.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["pos.drawer", "wallet.view"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const drawer = await getDrawerSummary(prisma, id);
  if (!drawer) return NextResponse.json({ error: "Drawer not found" }, { status: 404 });
  return NextResponse.json({ drawer });
}
