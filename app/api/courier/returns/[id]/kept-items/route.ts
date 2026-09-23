import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { markKeptItems } from "@/lib/courier/partial-delivery";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { prisma } from "@/lib/prisma";

// Partial delivery: record which items the customer kept. The rest queue for
// the condition check; the order total/due are recomputed on what was kept.
// Audit-logged (with before/after totals) inside the service. A changed
// total regenerates the invoice as a new version, old ones kept — the same
// rule as an approved order edit (PRD §6 invariant 8).
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
    let invoiceRegenerated = false;
    if (result.totalChanged) {
      try {
        await generateOrderInvoice(result.orderId, guard.user.id);
        invoiceRegenerated = true;
      } catch (invoiceError) {
        // The money change is committed and audited; a failed PDF render must not undo it.
        console.error(`Failed to regenerate invoice after partial delivery for order ${result.orderId}:`, invoiceError);
      }
    }
    return NextResponse.json({ ok: true, returnedUnits: result.returnedUnits, invoiceRegenerated });
  } catch (error) {
    return courierErrorResponse(error);
  }
}
