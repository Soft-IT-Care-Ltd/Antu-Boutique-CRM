import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, financeErrorResponse } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { getWalletBalances } from "@/lib/wallets/ledger";
import { createWallet } from "@/lib/wallets/service";
import { walletBodySchema } from "@/lib/wallets/validation";

// PRD §4.10 — wallets with running balances. Balances are derived, never
// stored (lib/wallets/ledger.ts). Admin/Manager/Accounts only (wallet.view).

export async function GET() {
  const guard = await requirePermission("wallet.view");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ wallets: await getWalletBalances(prisma) });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("wallet.manage");
  if (!guard.ok) return guard.response;
  const parsed = walletBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;
  if (await prisma.wallet.findUnique({ where: { name: body.name } })) {
    return NextResponse.json({ error: `A wallet called "${body.name}" already exists` }, { status: 409 });
  }
  try {
    const wallet = await prisma.$transaction((tx) => createWallet(tx, { ...body, openingDate: dhakaDayStartUtc(body.openingDate) }, guard.user.id));
    return NextResponse.json({ wallet: { id: wallet.id } }, { status: 201 });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
