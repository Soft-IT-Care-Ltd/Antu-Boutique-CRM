import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { lookupStoreCreditByPhone } from "@/lib/store-credit/ledger";

// P3.2 — "shown at checkout when a known phone number is entered": the POS
// and the order form ask what store credit a phone number has. Only the
// balance comes back — never the customer's name or record, which may
// belong to another executive (PRD §4.7).
export async function GET(request: NextRequest) {
  const guard = await requirePermission(["pos.sell", "order.create", "payment.create"]);
  if (!guard.ok) return guard.response;
  const parsed = z.object({ phone: z.string().trim().min(1).max(20) }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  if (!isValidBdPhone(parsed.data.phone)) return NextResponse.json({ known: false, balance: "0.00" });
  return NextResponse.json(await lookupStoreCreditByPhone(prisma, normalizeBdPhone(parsed.data.phone)));
}
