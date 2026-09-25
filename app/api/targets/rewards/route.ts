import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { badRequest, monthString, TARGET_VIEW_PERMISSIONS, targetViewLevel } from "@/lib/targets/http";
import { dhakaMonth } from "@/lib/targets/month";
import { getMonthAwards } from "@/lib/targets/rewards";

// A month's rewards — saved once worked out, a live preview before that.
export async function GET(request: NextRequest) {
  const guard = await requirePermission(TARGET_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = z.object({ month: monthString.optional() }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const level = (await targetViewLevel(guard.user))!;
  return NextResponse.json({ awards: await getMonthAwards(prisma, guard.user, level, parsed.data.month ?? dhakaMonth()) });
}
