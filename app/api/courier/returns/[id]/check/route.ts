import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";
import { completeConditionCheck } from "@/lib/returns/condition-check";

// Packing's condition check: Good → RETURN_IN, Damaged → DAMAGE_OUT + expense
// at cost; a courier return also posts the return charge. Stock and ledger in
// one transaction (CLAUDE.md rule 2); audit-logged inside the service.
const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        orderItemId: z.string().cuid(),
        goodQty: z.coerce.number().int().min(0).max(10_000),
        damagedQty: z.coerce.number().int().min(0).max(10_000),
      }),
    )
    .min(1)
    .max(50),
  note: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("courier.return_check");
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);

  const visible = await prisma.returnInspection.findFirst({ where: { id, order: scopedWhere({ deletedAt: null }, guard.user) }, select: { id: true } });
  if (!visible) return NextResponse.json({ error: "Return not found" }, { status: 404 });

  try {
    const result = await prisma.$transaction((tx) => completeConditionCheck(tx, { inspectionId: id, ...parsed.data }, guard.user.id), { timeout: 30_000 });
    // Unit counts only — the return charge amount is cost data and Packing
    // (the main caller) must not see it.
    return NextResponse.json({ ok: true, restockedUnits: result.restockedUnits, writtenOffUnits: result.writtenOffUnits });
  } catch (error) {
    return courierErrorResponse(error);
  }
}
