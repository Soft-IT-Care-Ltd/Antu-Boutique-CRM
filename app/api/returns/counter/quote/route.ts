import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { quoteCounterExchange } from "@/lib/returns/cases";
import { returnsErrorResponse } from "@/lib/returns/http";
import { counterQuoteSchema } from "@/lib/returns/validation";

// The counter exchange screen's preview of the difference — the same
// arithmetic as the exchange itself, nothing written. Selling prices only.
export async function POST(request: NextRequest) {
  const guard = await requirePermission(["pos.sell", "exchange.create"], "all");
  if (!guard.ok) return guard.response;
  const parsed = counterQuoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return NextResponse.json({ quote: await quoteCounterExchange(prisma, parsed.data) });
  } catch (error) {
    return returnsErrorResponse(error);
  }
}
