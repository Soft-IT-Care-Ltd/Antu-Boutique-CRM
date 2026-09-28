import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { assertCanActAt, LocationError } from "@/lib/locations/service";
import { StockMovementError, writeOffDamagedStock } from "@/lib/inventory/adjustments";

// PRD §4.3: damage/write-off posts DAMAGE_OUT and an expense line at cost —
// both in one transaction (lib/inventory/adjustments.ts). Gated like a
// manual adjustment: it's a stock correction only Admin/Manager may make.

const bodySchema = z.object({
  variantId: z.string().trim().min(1),
  // C3 — the location whose stock is corrected; only one the user acts for.
  locationId: z.string().trim().min(1, "Pick a location").max(50),
  qty: z.number().int("Quantity must be a whole number").min(1, "Write off at least 1").max(100_000),
  reason: z.string().trim().min(3, "Say what was wrong with it").max(500),
});

export async function POST(request: NextRequest) {
  const guard = await requirePermission("inventory.adjust");
  if (!guard.ok) return guard.response;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const location = await assertCanActAt(prisma, guard.user, parsed.data.locationId);
    const { movement, expense } = await prisma.$transaction((tx) => writeOffDamagedStock(tx, parsed.data, guard.user.id));

    await writeAuditLog({
      actorId: guard.user.id,
      action: "inventory.write_off",
      entityType: "product_variant",
      entityId: movement.variantId,
      before: { stockQty: movement.stockAfter - movement.qty, location: location.name, locationQty: movement.locationStockAfter - movement.qty },
      after: {
        stockQty: movement.stockAfter,
        location: location.name,
        locationQty: movement.locationStockAfter,
        movementId: movement.id,
        qty: movement.qty,
        unitCost: movement.unitCostSnapshot.toString(),
        expenseId: expense?.id ?? null,
        expenseAmount: expense?.amount.toString() ?? null,
        reason: parsed.data.reason,
      },
      request,
    });

    return NextResponse.json(
      { movement: { id: movement.id, qty: movement.qty, stockAfter: movement.stockAfter }, expenseId: expense?.id ?? null },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof StockMovementError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof LocationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
