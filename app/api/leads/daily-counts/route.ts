import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { dayRange, dayString } from "@/lib/finance/http";
import { LEAD_SOURCE_VALUES, MAX_DAILY_COUNT_ROWS } from "@/lib/leads/constants";
import { getDailySheet, listDailyCountDays, saveDailySheet } from "@/lib/leads/daily-counts";
import { badRequest, LEAD_VIEW_PERMISSIONS, leadErrorResponse } from "@/lib/leads/http";
import { prisma } from "@/lib/prisma";

// PRD §4.5 bulk daily-count quick entry. GET with userId+day returns that
// sheet; GET with a range lists saved days. PUT saves one sheet whole.

const querySchema = z.union([
  z.object({ userId: z.string().cuid(), day: dayString }),
  z.object({ from: dayString.optional(), to: dayString.optional(), userId: z.string().cuid().optional() }),
]);

export async function GET(request: NextRequest) {
  const guard = await requirePermission(LEAD_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    if ("day" in parsed.data && parsed.data.day) {
      return NextResponse.json({ sheet: await getDailySheet(prisma, guard.user, parsed.data.userId, parsed.data.day) });
    }
    const q = parsed.data as { from?: string; to?: string; userId?: string };
    const range = dayRange(q.from, q.to);
    if (range.toDay < range.fromDay) return NextResponse.json({ error: "The end date is before the start date" }, { status: 400 });
    return NextResponse.json({ fromDay: range.fromDay, toDay: range.toDay, days: await listDailyCountDays(prisma, guard.user, { fromDay: range.fromDay, toDay: range.toDay, userId: q.userId }) });
  } catch (error) {
    return leadErrorResponse(error);
  }
}

const rowSchema = z.object({
  source: z.enum(LEAD_SOURCE_VALUES),
  campaign: z.string().trim().max(100).nullish().transform((v) => v || null),
  leadCount: z.coerce.number().int("Counts are whole numbers").min(0).max(10_000),
  convertedCount: z.coerce.number().int("Counts are whole numbers").min(0).max(10_000).default(0),
});

const saveSchema = z.object({
  userId: z.string().cuid(),
  day: dayString,
  rows: z.array(rowSchema).max(MAX_DAILY_COUNT_ROWS * 2),
});

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("lead.create");
  if (!guard.ok) return guard.response;

  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    return NextResponse.json({ sheet: await saveDailySheet(prisma, guard.user, parsed.data, { request }) });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
