import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { getDrawerState, getPosCashWalletId, openDrawer } from "@/lib/pos/drawer";
import { posErrorResponse } from "@/lib/pos/http";
import { openDrawerSchema } from "@/lib/pos/validation";
import { prisma } from "@/lib/prisma";

// PRD §4.7 — the showroom cash drawer. GET: where today stands (the POS
// screen's status bar reads it too). POST: open today's drawer with a count.

export async function GET() {
  const guard = await requirePermission(["pos.sell", "pos.drawer", "wallet.view"]);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ state: await getDrawerState(prisma, await getPosCashWalletId(prisma)) });
  } catch (error) {
    return posErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("pos.drawer");
  if (!guard.ok) return guard.response;
  const parsed = openDrawerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const drawer = await openDrawer(prisma, guard.user, await getPosCashWalletId(prisma), parsed.data);
    return NextResponse.json({ drawer }, { status: 201 });
  } catch (error) {
    return posErrorResponse(error);
  }
}
