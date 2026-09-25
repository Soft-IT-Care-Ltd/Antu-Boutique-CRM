import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { LEADERBOARD_SORTS } from "@/lib/targets/constants";
import { badRequest, monthString, TARGET_VIEW_PERMISSIONS, targetViewLevel } from "@/lib/targets/http";
import { dhakaMonth } from "@/lib/targets/month";
import { getLeaderboard } from "@/lib/targets/service";

// PRD §4.13 leaderboard. An executive gets only their own row (with their
// rank); a team leader their team; Admin/Manager everyone.
export async function GET(request: NextRequest) {
  const guard = await requirePermission(TARGET_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = z
    .object({ month: monthString.optional(), sort: z.enum(LEADERBOARD_SORTS).default("value") })
    .safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const level = (await targetViewLevel(guard.user))!;
  return NextResponse.json({ leaderboard: await getLeaderboard(prisma, guard.user, level, parsed.data.month ?? dhakaMonth(), parsed.data.sort) });
}
