import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest } from "@/lib/finance/http";
import { findVariantByCode } from "@/lib/pos/lookup";
import { prisma } from "@/lib/prisma";

// A scanned price tag → its variant. The tag's barcode is the SKU exactly
// (lib/catalog/price-tags.ts); lib/barcode/scan.ts normalizes the scan.
const querySchema = z.object({ code: z.string().max(100) });

export async function GET(request: NextRequest) {
  const guard = await requirePermission("pos.sell");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const variant = await findVariantByCode(prisma, parsed.data.code);
  return NextResponse.json(await stripCostFieldsForUser({ variant }, guard.user));
}
