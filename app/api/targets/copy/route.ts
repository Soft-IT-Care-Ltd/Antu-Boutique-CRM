import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { badRequest, monthString, targetErrorResponse } from "@/lib/targets/http";
import { copyTargets } from "@/lib/targets/service";

// Carries the previous month's targets into `month` for anyone without one.
export async function POST(request: NextRequest) {
  const guard = await requirePermission("target.manage");
  if (!guard.ok) return guard.response;
  const parsed = z.object({ month: monthString }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return NextResponse.json({ copied: await copyTargets(prisma, guard.user, parsed.data.month, { request }) });
  } catch (error) {
    return targetErrorResponse(error);
  }
}
