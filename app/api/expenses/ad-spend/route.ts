import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { listAdSpend } from "@/lib/expenses/queries";
import { createAdSpend } from "@/lib/expenses/service";
import { adSpendSchema } from "@/lib/expenses/validation";
import { badRequest, dayString, financeErrorResponse } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// PRD §4.12 — daily ad spend. Each row posts one "Ad cost" expense (paid
// from its wallet) and is spread over that day's confirmed orders.
const querySchema = z.object({
  from: dayString.optional(),
  to: dayString.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("expense.view");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const { from, to, ...rest } = parsed.data;
  return NextResponse.json(await listAdSpend({ ...rest, from: from ? dhakaDayStartUtc(from) : undefined, to: to ? dhakaDayStartUtc(to, 1) : undefined }));
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("expense.create");
  if (!guard.ok) return guard.response;
  const parsed = adSpendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const spend = await prisma.$transaction((tx) => createAdSpend(tx, { ...parsed.data, spendDate: dhakaDayStartUtc(parsed.data.spendDate) }, guard.user.id));
    return NextResponse.json({ adSpend: { id: spend.id } }, { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
