import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { getProductPackaging, setPackaging } from "@/lib/packaging/service";
import { prisma } from "@/lib/prisma";
import { packagingListSchema } from "@/lib/sets/validation";

// P3.3 — the packaging each unit of this product uses (a box per saree, a
// tag per garment). Deducted when it's packed or sold, sets included.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  return NextResponse.json({ packaging: await getProductPackaging(prisma, id) });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("product.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = z.object({ lines: packagingListSchema }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await setPackaging(prisma, guard.user.id, { productId: id }, parsed.data.lines, request);
    return NextResponse.json({ packaging: await getProductPackaging(prisma, id) });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
