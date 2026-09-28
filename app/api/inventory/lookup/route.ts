import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { lookupStock } from "@/lib/inventory/lookup";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 2 — stock lookup by scan, SKU or name: every
// location's quantity. Cost-free by construction; stripped anyway.
const querySchema = z.object({ q: z.string().trim().min(1, "Type or scan something").max(100) });

export async function GET(request: NextRequest) {
  const guard = await requirePermission("inventory.view");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  return NextResponse.json(await stripCostFieldsForUser(await lookupStock(prisma, parsed.data.q), guard.user));
}
