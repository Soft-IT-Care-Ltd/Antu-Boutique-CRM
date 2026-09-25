import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { EXPENSE_KIND_FILTER_VALUES, EXPENSE_NATURE_VALUES } from "@/lib/expenses/constants";
import { listExpenses } from "@/lib/expenses/queries";
import { createExpense } from "@/lib/expenses/service";
import { badRequest, dayString, financeErrorResponse, idString, money, moneyDayString } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// PRD §4.12 — daily expense entry. Admin/Manager/Accounts (expense.*).
const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: idString.optional(),
  kind: z.enum(EXPENSE_KIND_FILTER_VALUES).optional(),
  nature: z.enum(EXPENSE_NATURE_VALUES).optional(),
  walletId: idString.optional(),
  from: dayString.optional(),
  to: dayString.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const createSchema = z.object({
  expenseDate: moneyDayString,
  categoryId: idString,
  nature: z.enum(EXPENSE_NATURE_VALUES),
  amount: money,
  walletId: idString,
  note: z.string().trim().max(500).nullish(),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("expense.view");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const { from, to, q, ...rest } = parsed.data;
  return NextResponse.json(
    await listExpenses({ ...rest, q: q || undefined, from: from ? dhakaDayStartUtc(from) : undefined, to: to ? dhakaDayStartUtc(to, 1) : undefined }),
  );
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("expense.create");
  if (!guard.ok) return guard.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const expense = await prisma.$transaction((tx) => createExpense(tx, { ...parsed.data, expenseDate: dhakaDayStartUtc(parsed.data.expenseDate) }, guard.user.id));
    return NextResponse.json({ expense: { id: expense.id } }, { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
