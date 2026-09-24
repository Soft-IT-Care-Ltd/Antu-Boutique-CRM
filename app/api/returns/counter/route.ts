import { NextResponse, type NextRequest } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { getPosCashWalletId } from "@/lib/pos/drawer";
import { prisma } from "@/lib/prisma";
import { createCounterExchange } from "@/lib/returns/cases";
import { regenerateInvoices, returnsErrorResponse } from "@/lib/returns/http";
import { counterExchangeSchema } from "@/lib/returns/validation";

// PRD §4.11 B — an exchange at the showroom counter: inspected, swapped and
// settled in one transaction (lib/returns/cases.ts createCounterExchange).
// Needs no approval: a cheaper replacement's difference goes straight to the
// customer's store credit — no refund, no cash out of the drawer.
export async function POST(request: NextRequest) {
  const guard = await requirePermission(["pos.sell", "exchange.create"], "all");
  if (!guard.ok) return guard.response;
  const parsed = counterExchangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const [cashWalletId, canCreateCustomer] = await Promise.all([getPosCashWalletId(prisma), can(guard.user, "customer.create")]);
    const result = await createCounterExchange(prisma, { user: guard.user, cashWalletId, canCreateCustomer }, {
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
