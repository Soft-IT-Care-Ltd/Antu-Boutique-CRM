import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { deleteAdSpend, updateAdSpend } from "@/lib/expenses/service";
import { adSpendSchema } from "@/lib/expenses/validation";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// Editing or deleting a day's ad spend moves its posted expense with it.
const patchSchema = adSpendSchema.partial();

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("expense.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const { spendDate, ...rest } = parsed.data;
  try {
    await prisma.$transaction((tx) => updateAdSpend(tx, id, { ...rest, spendDate: spendDate ? dhakaDayStartUtc(spendDate) : undefined }, guard.user.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("expense.delete");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    await prisma.$transaction((tx) => deleteAdSpend(tx, id, guard.user.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
