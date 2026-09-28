import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { listOpeningStockCandidates, OpeningStockError, postOpeningStock } from "@/lib/catalog/opening-stock";
import { assertCanActAt, listActableLocations, LocationError } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 4 — the product page's stock-in grid. Opening stock
// carries a unit cost (it becomes the average cost), so it needs
// product.cost.view on top of product.create, like the CSV import; and each
// location must be one the person acts for.

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.string().trim().min(1).max(50),
        unitCost: z.coerce.number({ error: "Enter a unit cost" }).min(0, "Costs can't be negative").max(10_000_000),
        quantities: z.array(z.object({ locationId: z.string().trim().min(1).max(50), qty: z.coerce.number().int("Whole numbers only").min(0).max(100_000) })).max(50),
      }),
    )
    .min(1)
    .max(200),
});

const COST_DENIED = { error: "Opening stock carries a cost — you need cost access to enter it." };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.create");
  if (!guard.ok) return guard.response;
  if (!(await can(guard.user, "product.cost.view"))) return NextResponse.json(COST_DENIED, { status: 403 });
  const { id } = await params;
  const [candidates, locations] = await Promise.all([listOpeningStockCandidates(prisma, id), listActableLocations(prisma, guard.user)]);
  return NextResponse.json({ candidates, locations });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.create");
  if (!guard.ok) return guard.response;
  if (!(await can(guard.user, "product.cost.view"))) return NextResponse.json(COST_DENIED, { status: 403 });
  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });

  try {
    const locationIds = new Set(parsed.data.lines.flatMap((l) => l.quantities.filter((q) => q.qty > 0).map((q) => q.locationId)));
    for (const locationId of locationIds) await assertCanActAt(prisma, guard.user, locationId);
    const result = await prisma.$transaction((tx) => postOpeningStock(tx, { productId: id, lines: parsed.data.lines }, guard.user.id, request), { timeout: 30_000 });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof OpeningStockError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof LocationError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
