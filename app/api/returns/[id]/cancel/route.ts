import { NextResponse, type NextRequest } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { cancelReturnCase } from "@/lib/returns/cases";
import { regenerateInvoices, returnsErrorResponse } from "@/lib/returns/http";
import { caseCancelSchema } from "@/lib/returns/validation";

// PRD §4.11 — withdraw a request (whoever asked, or an approver), or cancel
// an approved return/exchange before its item is checked in (approvers only;
// the service undoes the replacement, the credit and the returned units).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["return.create", "exchange.create", "return.approve", "exchange.approve"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = caseCancelSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const returnCase = await prisma.returnCase.findFirst({ where: { id, order: scopedWhere({ deletedAt: null }, guard.user) }, select: { type: true } });
  if (!returnCase) return NextResponse.json({ error: "Return not found" }, { status: 404 });
  const canApprove = await can(guard.user, returnCase.type === "EXCHANGE" ? "exchange.approve" : "return.approve");

  try {
    const result = await cancelReturnCase(prisma, guard.user, id, { note: parsed.data.note, canApprove });
    await regenerateInvoices(result.totalsChanged, guard.user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return returnsErrorResponse(error);
  }
}
