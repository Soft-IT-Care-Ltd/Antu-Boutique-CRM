import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, financeErrorResponse, idString, money, moneyDayString } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { createTransfer } from "@/lib/wallets/service";

// Moving money between our own wallets (bKash cash-out to the bank, cash deposit...).
const bodySchema = z
  .object({
    fromWalletId: idString,
    toWalletId: idString,
    amount: money,
    entryDate: moneyDayString,
    note: z.string().trim().min(3, "Say what this transfer was").max(300),
  })
  .refine((b) => b.fromWalletId !== b.toWalletId, "Pick two different wallets");

export async function POST(request: NextRequest) {
  const guard = await requirePermission("wallet.entry");
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const { transferId } = await prisma.$transaction((tx) => createTransfer(tx, { ...parsed.data, entryDate: dhakaDayStartUtc(parsed.data.entryDate) }, guard.user.id));
    return NextResponse.json({ transferId }, { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
