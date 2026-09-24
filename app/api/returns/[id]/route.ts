import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { getReturnCase } from "@/lib/returns/queries";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["return.view", "exchange.view"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const returnCase = await getReturnCase(prisma, guard.user, id);
  if (!returnCase) return NextResponse.json({ error: "Return not found" }, { status: 404 });
  return NextResponse.json({ returnCase });
}
