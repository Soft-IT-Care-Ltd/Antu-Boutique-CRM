import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { badRequest, monthString, targetErrorResponse } from "@/lib/targets/http";
import { evaluateMonth } from "@/lib/targets/rewards";

// Works out (or re-works) a closed month's rewards by hand. The month-end
// cron does this automatically; re-running replaces the month's awards.
export async function POST(request: NextRequest) {
  const guard = await requirePermission("target.manage");
  if (!guard.ok) return guard.response;
  const parsed = z.object({ month: monthString }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return NextResponse.json({ awards: await evaluateMonth(prisma, guard.user, parsed.data.month, { request }) });
  } catch (error) {
    return targetErrorResponse(error);
  }
}
