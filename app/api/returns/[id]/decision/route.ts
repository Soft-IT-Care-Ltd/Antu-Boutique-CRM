import { NextResponse, type NextRequest } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { decideReturnCase } from "@/lib/returns/cases";
import { regenerateInvoices, returnsErrorResponse } from "@/lib/returns/http";
import { caseDecisionSchema } from "@/lib/returns/validation";

// PRD §4.11 — a TL/Manager/Admin approves or rejects a return/exchange
// request (return.approve / exchange.approve, within their order scope, never
// their own request). Approval sets up the money and the replacement in one
// transaction, audit-logged inside the service.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["return.approve", "exchange.approve"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = caseDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const returnCase = await prisma.returnCase.findFirst({ where: { id, order: scopedWhere({ deletedAt: null }, guard.user) }, select: { type: true } });
  if (!returnCase) return NextResponse.json({ error: "Return not found" }, { status: 404 });
  if (!(await can(guard.user, returnCase.type === "EXCHANGE" ? "exchange.approve" : "return.approve"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await decideReturnCase(prisma, guard.user, id, parsed.data);
    if (result) await regenerateInvoices(result.totalsChanged, guard.user.id);
    return NextResponse.json({ ok: true, ...(result ? { replacementOrderId: result.replacementOrderId, replacementOrderNo: result.replacementOrderNo, owedToCustomer: result.owedToCustomer } : {}) });
  } catch (error) {
    return returnsErrorResponse(error);
  }
}
