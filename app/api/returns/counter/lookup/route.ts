import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { lookupOrderForCounter } from "@/lib/returns/queries";

// Counter exchange: find the sale on the customer's receipt by its exact
// order number, whoever made it (see lookupOrderForCounter — items only, no
// contact details, payments or cost). Showroom staff who can sell AND
// create exchanges only.
const querySchema = z.object({ orderNo: z.string().trim().min(4, "Enter the order number from the receipt").max(30) });

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["pos.sell", "exchange.create"], "all");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const order = await lookupOrderForCounter(prisma, parsed.data.orderNo);
  if (!order) return NextResponse.json({ error: `No order ${parsed.data.orderNo.toUpperCase()} — check the number on the receipt.` }, { status: 404 });
  return NextResponse.json({ order });
}
