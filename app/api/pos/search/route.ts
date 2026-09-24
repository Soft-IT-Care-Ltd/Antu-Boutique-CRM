import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest } from "@/lib/finance/http";
import { searchSellableVariants } from "@/lib/pos/lookup";
import { prisma } from "@/lib/prisma";

// POS type-ahead (CORRECTIONS Round 2 §2.3): product name, code or SKU →
// every sellable size/colour, with price and live available stock.
const querySchema = z.object({ q: z.string().trim().min(1).max(100) });

export async function GET(request: NextRequest) {
  const guard = await requirePermission("pos.sell");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  return NextResponse.json(await stripCostFieldsForUser({ variants: await searchSellableVariants(prisma, parsed.data.q) }, guard.user));
}
