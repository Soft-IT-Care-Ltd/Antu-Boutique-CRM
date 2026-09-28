import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest } from "@/lib/finance/http";
import { searchSellableVariants } from "@/lib/pos/lookup";
import { getPosLocation } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";
import { listSets } from "@/lib/sets/service";

// POS type-ahead (CORRECTIONS Round 2 §2.3): product name, code or SKU →
// every sellable size/colour, with price and live available stock. P3.3:
// plus outfit sets by name (sizes/colours are picked when one is added).
const querySchema = z.object({ q: z.string().trim().min(1).max(100) });

export async function GET(request: NextRequest) {
  const guard = await requirePermission("pos.sell");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const showroom = await getPosLocation(prisma, guard.user).catch(() => null);
  if (!showroom) return NextResponse.json({ error: "No POS showroom for you — ask an Admin to assign you in Settings → Locations." }, { status: 403 });
  const [variants, sets] = await Promise.all([searchSellableVariants(prisma, parsed.data.q, showroom.id), listSets(prisma, { q: parsed.data.q, activeOnly: true, take: 5 })]);
  return NextResponse.json(await stripCostFieldsForUser({ variants, sets }, guard.user));
}
