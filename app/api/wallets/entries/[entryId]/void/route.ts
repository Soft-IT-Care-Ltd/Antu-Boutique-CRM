import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { voidWalletEntry } from "@/lib/wallets/service";

// Entries are voided (with a reason), never deleted — a transfer voids both halves.
const bodySchema = z.object({ reason: z.string().trim().min(3, "Give a reason").max(300) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ entryId: string }> }) {
  const guard = await requirePermission("wallet.entry");
  if (!guard.ok) return guard.response;
  const { entryId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const voided = await prisma.$transaction((tx) => voidWalletEntry(tx, entryId, parsed.data.reason, guard.user.id));
    return NextResponse.json({ voided });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
