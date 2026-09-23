import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, dayRange, dayString } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { getCollectionReport } from "@/lib/reports/finance";

const querySchema = z
  .object({ from: dayString.optional(), to: dayString.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "The start date must be on or before the end date");

export async function GET(request: NextRequest) {
  const guard = await requirePermission("payment.view");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const range = dayRange(parsed.data.from, parsed.data.to);
  return NextResponse.json({ report: await getCollectionReport(prisma, guard.user, range.from, range.to), fromDay: range.fromDay, toDay: range.toDay });
}
