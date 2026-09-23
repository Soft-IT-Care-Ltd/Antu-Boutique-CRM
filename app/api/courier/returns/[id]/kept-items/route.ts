import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { markKeptItems } from "@/lib/courier/partial-delivery";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";

// Partial delivery: record which items the customer kept. The rest queue for
// the condition check; the order total/due are recomputed on what was kept.
// Audit-logged (with before/after totals) inside the service.
const bodySchema = z.object({
  kept: z.array(z.object({ orderItemId: z.string().cuid(), keptQty: z.coerce.number().int().min(0).max(10_000) })).min(1).max(50),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["courier.return_check", "courier.reconcile"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);

  const visible = await prisma.returnInspection.findFirst({ where: { id, order: scopedWhere({ deletedAt: null }, guard.user) }, select: { id: true } });
  if (!visible) return NextResponse.json({ error: "Return not found" }, { status: 404 });

  try {
    // The response deliberately carries no money: Packing may call this.
    const result = await prisma.$transaction((tx) => markKeptItems(tx, { inspectionId: id, kept: parsed.data.kept }, guard.user.id), { timeout: 30_000 });
    return NextResponse.json({ ok: true, returnedUnits: result.returnedUnits });
  } catch (error) {
    return courierErrorResponse(error);
  }
}
