import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { getPackagingDefaults, listPackagingMaterials, setPackaging } from "@/lib/packaging/service";
import { prisma } from "@/lib/prisma";
import { packagingListSchema } from "@/lib/sets/validation";

// P3.3 — packaging materials (bags, boxes, tissue, tags) and what every
// online parcel and every showroom sale uses. Cost stripped for non-cost roles.

export async function GET() {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;
  const [materials, defaults] = await Promise.all([listPackagingMaterials(prisma), getPackagingDefaults(prisma)]);
  return NextResponse.json(await stripCostFieldsForUser({ materials, defaults }, guard.user));
}

const putSchema = z.object({ scope: z.enum(["ONLINE_PARCEL", "POS_SALE"]), lines: packagingListSchema });

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("catalog.manage");
  if (!guard.ok) return guard.response;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await setPackaging(prisma, guard.user.id, { scope: parsed.data.scope }, parsed.data.lines, request);
    return NextResponse.json({ defaults: await getPackagingDefaults(prisma) });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
