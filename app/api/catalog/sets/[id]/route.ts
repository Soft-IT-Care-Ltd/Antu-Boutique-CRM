import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { deleteSet, getSetDetail, saveSet } from "@/lib/sets/service";
import { setInputSchema } from "@/lib/sets/validation";

// One outfit set: its components with every size/colour and what's
// available (the order form and POS pick from this), its packaging, and —
// for cost roles only — its cost (stripped at the API, CLAUDE.md rule 5).

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const set = await getSetDetail(prisma, id);
  if (!set) return NextResponse.json({ error: "Set not found" }, { status: 404 });
  return NextResponse.json(await stripCostFieldsForUser({ set }, guard.user));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = setInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await saveSet(prisma, guard.user.id, parsed.data, id, request);
    return NextResponse.json(await stripCostFieldsForUser({ set: await getSetDetail(prisma, id) }, guard.user));
  } catch (error) {
    return financeErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.delete");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    await deleteSet(prisma, guard.user.id, id, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
