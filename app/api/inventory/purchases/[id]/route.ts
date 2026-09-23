import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { toPaisa } from "@/lib/inventory/costing";
import { computePurchaseDue } from "@/lib/inventory/purchases";
import { PURCHASE_VIEW_PERMISSIONS, getPurchaseDetail } from "@/lib/inventory/queries";

// A saved purchase's lines are immutable — they already moved stock and
// WAC. Only the supplier-payment side can change here; dueAmount is always
// recomputed from totalCost − amountPaid, never accepted from the client.
const patchSchema = z
  .object({
    amountPaid: z.coerce.number().min(0, "Amount paid can't be negative").max(100_000_000).optional(),
    invoiceNo: z.string().trim().max(60).nullish(),
    note: z.string().trim().max(1000).nullish(),
  })
  .strict();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(PURCHASE_VIEW_PERMISSIONS, "all");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const purchase = await getPurchaseDetail(id);
  if (!purchase) return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
  return NextResponse.json(await stripCostFieldsForUser({ purchase }, guard.user));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(PURCHASE_VIEW_PERMISSIONS, "all");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const before = await prisma.purchase.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: "Purchase not found" }, { status: 404 });

  const { amountPaid, invoiceNo, note } = parsed.data;
  if (amountPaid !== undefined && toPaisa(amountPaid) > toPaisa(before.totalCost)) {
    return NextResponse.json({ error: "Amount paid can't be more than the purchase total" }, { status: 400 });
  }

  const nextPaid = amountPaid ?? before.amountPaid;
  try {
    const after = await prisma.purchase.update({
      where: { id },
      data: {
        amountPaid: amountPaid === undefined ? undefined : amountPaid.toFixed(2),
        dueAmount: computePurchaseDue(before.totalCost, nextPaid),
        invoiceNo: invoiceNo === undefined ? undefined : invoiceNo || null,
        note: note === undefined ? undefined : note || null,
      },
    });

    await writeAuditLog({
      actorId: guard.user.id,
      action: "purchase.update_payment",
      entityType: "purchase",
      entityId: id,
      before: { amountPaid: before.amountPaid.toString(), dueAmount: before.dueAmount.toString(), invoiceNo: before.invoiceNo, note: before.note },
      after: { amountPaid: after.amountPaid.toString(), dueAmount: after.dueAmount.toString(), invoiceNo: after.invoiceNo, note: after.note },
      request,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "This supplier invoice number has already been entered" }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json(await stripCostFieldsForUser({ purchase: await getPurchaseDetail(id) }, guard.user));
}
