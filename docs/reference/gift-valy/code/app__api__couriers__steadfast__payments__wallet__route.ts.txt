import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, apiError, AuthzError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { SETTING_KEYS } from "@/lib/settings";

// CORRECTIONS Orders §R8 — which bank wallet Steadfast payouts deposit into.
// A paid payment's COD rows land here (gross in) and its two charge expenses
// draw from here (out), so the wallet's running balance moves by exactly the
// NET payout. null = unattributed (surfaces as "unassigned collected").
const bodySchema = z.object({
  walletId: z.number().int().positive().nullable(),
});

export async function PUT(req: Request) {
  try {
    const session = await requirePermission("courier.manage");
    const { walletId } = bodySchema.parse(await req.json());

    if (walletId != null) {
      const wallet = await prisma.wallet.findUnique({
        where: { id: walletId },
        select: { isActive: true },
      });
      if (!wallet) throw new AuthzError(400, "Wallet not found");
      if (!wallet.isActive) throw new AuthzError(400, "Wallet is inactive");
    }

    // value is a required Json column — clearing stores a JSON null.
    const value: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      walletId ?? Prisma.JsonNull;
    await prisma.setting.upsert({
      where: { key: SETTING_KEYS.steadfastPayoutWalletId },
      update: { value },
      create: { key: SETTING_KEYS.steadfastPayoutWalletId, value },
    });

    await logAudit({
      userId: session.user.id,
      action: "courier_integration.payout_wallet",
      entity: "settings",
      after: { walletId },
    });

    return NextResponse.json({ ok: true, walletId });
  } catch (e) {
    return apiError(e);
  }
}
