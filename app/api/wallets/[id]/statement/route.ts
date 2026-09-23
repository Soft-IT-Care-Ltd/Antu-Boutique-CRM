import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, dayRange, dayString } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { getWalletStatement } from "@/lib/wallets/ledger";

// PRD §4.10 — a wallet statement per date range (Dhaka days, inclusive).
const querySchema = z
  .object({ from: dayString.optional(), to: dayString.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "The start date must be on or before the end date");

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("wallet.view");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const range = dayRange(parsed.data.from, parsed.data.to);
  const statement = await getWalletStatement(prisma, id, range.from, range.to);
  if (!statement) return NextResponse.json({ error: "Wallet not found" }, { status: 404 });
  return NextResponse.json({ statement, fromDay: range.fromDay, toDay: range.toDay });
}
