import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { getPosCashWalletId } from "@/lib/pos/drawer";
import { prisma } from "@/lib/prisma";
import { createCounterExchange } from "@/lib/returns/cases";
import { regenerateInvoices, returnsErrorResponse } from "@/lib/returns/http";
import { counterExchangeSchema } from "@/lib/returns/validation";

// PRD §4.11 B — an exchange at the showroom counter: inspected, swapped and
// settled in one transaction (lib/returns/cases.ts createCounterExchange).
// Needs no approval; a refund for a cheaper replacement does (P2.3).
export async function POST(request: NextRequest) {
  const guard = await requirePermission(["pos.sell", "exchange.create"], "all");
  if (!guard.ok) return guard.response;
  const parsed = counterExchangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const cashWalletId = await getPosCashWalletId(prisma);
    const result = await createCounterExchange(prisma, { user: guard.user, cashWalletId }, {
      ...parsed.data,
      tenders: parsed.data.tenders.map((t) => ({ ...t, transactionId: t.transactionId || null })),
    });
    // The original's total dropped by what came back: a new invoice version.
    const { orderId } = parsed.data;
    await regenerateInvoices([orderId], guard.user.id);
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    return returnsErrorResponse(error);
  }
}
