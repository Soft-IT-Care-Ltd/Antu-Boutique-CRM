import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { updateWallet } from "@/lib/wallets/service";
import { walletBodySchema } from "@/lib/wallets/validation";

// Opening balance/date edits move every balance for this wallet — audited
// with before/after (lib/wallets/service.ts). Wallets are deactivated, never deleted.
const patchSchema = walletBodySchema.partial().extend({ isActive: z.boolean().optional() });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("wallet.manage");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const { openingDate, ...rest } = parsed.data;
  if (rest.name) {
    const clash = await prisma.wallet.findFirst({ where: { name: rest.name, id: { not: id } } });
    if (clash) return NextResponse.json({ error: `A wallet called "${rest.name}" already exists` }, { status: 409 });
  }
  try {
    await prisma.$transaction((tx) => updateWallet(tx, id, { ...rest, openingDate: openingDate ? dhakaDayStartUtc(openingDate) : undefined }, guard.user.id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
