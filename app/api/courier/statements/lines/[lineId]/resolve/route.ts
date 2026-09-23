import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { resolveStatementLine } from "@/lib/courier/reconcile";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";

// ACCOUNTS resolves a discrepancy: accept the courier's figure (settles the
// order's COD) or dispute it. A reason is required either way; audit-logged
// in the service.
const bodySchema = z.object({ action: z.enum(["ACCEPT", "DISPUTE"]), note: z.string().trim().min(5, "Write a short reason").max(500) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ lineId: string }> }) {
  const guard = await requirePermission("courier.reconcile");
  if (!guard.ok) return guard.response;
  const { lineId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);
  try {
    const result = await prisma.$transaction((tx) => resolveStatementLine(tx, { lineId, ...parsed.data }, guard.user.id), { timeout: 30_000 });
    return NextResponse.json(result);
  } catch (error) {
    return courierErrorResponse(error);
  }
}
