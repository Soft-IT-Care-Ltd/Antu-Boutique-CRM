import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { listSets, saveSet } from "@/lib/sets/service";
import { setInputSchema } from "@/lib/sets/validation";

// PRD §4.2 (P3.3) — outfit sets. Listed by anyone who sees the catalog
// (selling prices and availability only — no cost in the list); created by
// product.create.

const querySchema = z.object({ q: z.string().trim().max(100).optional(), activeOnly: z.enum(["1", "0"]).optional() });

export async function GET(request: NextRequest) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  return NextResponse.json({ sets: await listSets(prisma, { q: parsed.data.q, activeOnly: parsed.data.activeOnly === "1" }) });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("product.create");
  if (!guard.ok) return guard.response;
  const parsed = setInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const set = await saveSet(prisma, guard.user.id, parsed.data, undefined, request);
    return NextResponse.json({ set }, { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
