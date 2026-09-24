import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { closeDrawer } from "@/lib/pos/drawer";
import { posErrorResponse } from "@/lib/pos/http";
import { closeDrawerSchema } from "@/lib/pos/validation";
import { prisma } from "@/lib/prisma";

// Day-end count: freezes the expected figure, verifies the day's cash
// payments, posts any over/short once (lib/pos/drawer.ts closeDrawer).
export async function POST(request: NextRequest) {
  const guard = await requirePermission("pos.drawer");
  if (!guard.ok) return guard.response;
  const parsed = closeDrawerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return NextResponse.json({ drawer: await closeDrawer(prisma, guard.user, parsed.data) });
  } catch (error) {
    return posErrorResponse(error);
  }
}
