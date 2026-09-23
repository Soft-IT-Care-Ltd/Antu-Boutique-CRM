import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, dayString, financeErrorResponse, idString, money } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { createManualEntry } from "@/lib/wallets/service";

// Manual money in/out of a wallet (owner top-up, bank charge...). A reason is required.
const bodySchema = z.object({
  walletId: idString,
  direction: z.enum(["IN", "OUT"]),
  amount: money,
  entryDate: dayString,
  note: z.string().trim().min(3, "Say what this money was").max(300),
});

export async function POST(request: NextRequest) {
  const guard = await requirePermission("wallet.entry");
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const entry = await prisma.$transaction((tx) => createManualEntry(tx, { ...parsed.data, entryDate: dhakaDayStartUtc(parsed.data.entryDate) }, guard.user.id));
    return NextResponse.json({ entry: { id: entry.id } }, { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
