import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { MAX_TARGET_VALUE } from "@/lib/targets/constants";
import { badRequest, monthString, TARGET_VIEW_PERMISSIONS, targetErrorResponse, targetViewLevel } from "@/lib/targets/http";
import { dhakaMonth } from "@/lib/targets/month";
import { getTargetBoard, setTarget } from "@/lib/targets/service";

// PRD §4.13 — a month's targets and live progress, scoped by
// target.view_all / _team / _own. Setting one needs target.manage.

export async function GET(request: NextRequest) {
  const guard = await requirePermission(TARGET_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = z.object({ month: monthString.optional() }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const level = (await targetViewLevel(guard.user))!;
  return NextResponse.json({ board: await getTargetBoard(prisma, guard.user, level, parsed.data.month ?? dhakaMonth()) });
}

const optionalCount = z.coerce.number().int("Whole orders only").positive("Enter a count above zero").max(100_000).nullable().optional();
const optionalValue = z.coerce.number().positive("Enter a value above zero").max(MAX_TARGET_VALUE, "Value is too large").multipleOf(0.01, "At most two decimals").nullable().optional();

const putSchema = z
  .object({
    month: monthString,
    userId: z.string().cuid().nullable().optional(),
    teamId: z.string().cuid().nullable().optional(),
    orderCount: optionalCount,
    orderValue: optionalValue,
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => Boolean(v.userId) !== Boolean(v.teamId), "A target is for one person or one team")
  .refine((v) => Boolean(v.orderCount) || Boolean(v.orderValue), "Set an order count, an order value, or both");

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("target.manage");
  if (!guard.ok) return guard.response;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const target = await setTarget(prisma, guard.user, parsed.data, { request });
    return NextResponse.json({ id: target.id });
  } catch (error) {
    return targetErrorResponse(error);
  }
}
