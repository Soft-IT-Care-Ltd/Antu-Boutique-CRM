import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { getPosCashWalletId, recordDrawerMovement } from "@/lib/pos/drawer";
import { posErrorResponse } from "@/lib/pos/http";
import { drawerMovementSchema } from "@/lib/pos/validation";
import { prisma } from "@/lib/prisma";

// Cash leaving or entering today's drawer mid-day: a deposit to another
// wallet, a petty expense, other cash out, or change added. Only from the
// drawer's own wallet, only dated today.
export async function POST(request: NextRequest) {
  const guard = await requirePermission("pos.drawer");
  if (!guard.ok) return guard.response;
  const parsed = drawerMovementSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const drawer = await recordDrawerMovement(prisma, guard.user, await getPosCashWalletId(prisma), parsed.data);
    return NextResponse.json({ drawer }, { status: 201 });
  } catch (error) {
    return posErrorResponse(error);
  }
}
