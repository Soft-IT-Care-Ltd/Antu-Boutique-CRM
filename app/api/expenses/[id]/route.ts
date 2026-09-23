import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { EXPENSE_NATURE_VALUES } from "@/lib/expenses/constants";
import { deleteExpense, updateExpense } from "@/lib/expenses/service";
import { badRequest, dayString, financeErrorResponse, idString, money } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  expenseDate: dayString.optional(),
  categoryId: idString.optional(),
  nature: z.enum(EXPENSE_NATURE_VALUES).optional(),
  amount: money.optional(),
  walletId: idString.optional(),
  note: z.string().trim().max(500).nullish(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("expense.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const { expenseDate, ...rest } = parsed.data;
  try {
    await prisma.$transaction((tx) => updateExpense(tx, id, { ...rest, expenseDate: expenseDate ? dhakaDayStartUtc(expenseDate) : undefined }, guard.user.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}

// Soft delete (CLAUDE.md rule 8). The receipt file stays until the trash purge.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("expense.delete");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    await prisma.$transaction((tx) => deleteExpense(tx, id, guard.user.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
