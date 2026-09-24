import { NextResponse, type NextRequest } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { requestReturnCase } from "@/lib/returns/cases";
import { returnsErrorResponse } from "@/lib/returns/http";
import { listReturnCases } from "@/lib/returns/queries";
import { caseListSchema, caseRequestSchema } from "@/lib/returns/validation";

// PRD §4.11 — GET lists returns/exchanges (scoped through the original
// order, CLAUDE.md rule 6); POST asks for one on an order the caller can see.

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["return.view", "exchange.view"]);
  if (!guard.ok) return guard.response;
  const parsed = caseListSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  // Someone who may only see one kind sees only that kind.
  const [returns, exchanges] = await Promise.all([can(guard.user, "return.view"), can(guard.user, "exchange.view")]);
  const type = returns && exchanges ? parsed.data.type : returns ? "RETURN" : "EXCHANGE";
  return NextResponse.json(await listReturnCases(prisma, guard.user, { ...parsed.data, type }));
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission(["return.create", "exchange.create"]);
  if (!guard.ok) return guard.response;
  const parsed = caseRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  if (!(await can(guard.user, parsed.data.type === "EXCHANGE" ? "exchange.create" : "return.create"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const visible = await prisma.order.findFirst({ where: scopedWhere({ id: parsed.data.orderId, deletedAt: null }, guard.user), select: { id: true } });
  if (!visible) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  try {
    const created = await requestReturnCase(prisma, guard.user, parsed.data);
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error) {
    return returnsErrorResponse(error);
  }
}
