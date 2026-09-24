import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { recentPurchasesForTags } from "@/lib/catalog/price-tags";
import { prisma } from "@/lib/prisma";

// Recent purchases to print tags for — date, supplier, invoice no. and units.
// No money: tag printing doesn't need (or get) purchase cost.
export async function GET() {
  const guard = await requirePermission("product.tags.print");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ purchases: await recentPurchasesForTags(prisma) });
}
