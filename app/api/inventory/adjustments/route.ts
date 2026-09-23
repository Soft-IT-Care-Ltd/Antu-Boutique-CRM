import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { adjustStock, StockMovementError } from "@/lib/inventory/adjustments";

// PRD §4.3: manual stock adjustment — reason required, Admin/Manager only
// (inventory.adjust is only in those two role templates). Posts its cost to
// "Stock shortage" (PRD §4.12): a shortfall as a cost, stock found as a credit.

const bodySchema = z.object({
  variantId: z.string().trim().min(1),
  qty: z
    .number()
    .int("Quantity must be a whole number")
    .refine((n) => n !== 0, "Quantity can't be zero")
    .refine((n) => Math.abs(n) <= 100_000, "Quantity is too large"),
  reason: z.string().trim().min(3, "Give a reason for the adjustment").max(500),
});

export async function POST(request: NextRequest) {
  const guard = await requirePermission("inventory.adjust");
  if (!guard.ok) return guard.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const { movement, expense } = await prisma.$transaction((tx) => adjustStock(tx, parsed.data, guard.user.id));

    await writeAuditLog({
      actorId: guard.user.id,
      action: "inventory.adjust",
      entityType: "product_variant",
      entityId: movement.variantId,
      before: { stockQty: movement.stockAfter - movement.qty },
      after: {
        stockQty: movement.stockAfter,
        movementId: movement.id,
        qty: movement.qty,
        unitCost: movement.unitCostSnapshot.toString(),
        expenseId: expense?.id ?? null,
        expenseAmount: expense?.amount.toString() ?? null,
        reason: parsed.data.reason,
      },
      request,
    });

    return NextResponse.json({ movement: { id: movement.id, qty: movement.qty, stockAfter: movement.stockAfter }, expenseId: expense?.id ?? null }, { status: 201 });
  } catch (err) {
    if (err instanceof StockMovementError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
