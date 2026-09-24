import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { adjustStoreCredit, getStoreCreditSummary, StoreCreditError } from "@/lib/store-credit/ledger";

// P3.2 — a customer's store credit: balance (derived, never stored) and
// ledger. Seen by whoever can see the customer (list scope, CLAUDE.md rule
// 6). Adjusting it is Admin-only (customer.credit.adjust), reason required,
// audit-logged in the ledger service.

const VIEW_PERMISSIONS: PermissionKey[] = ["customer.view_own", "customer.view_team", "customer.view_all"];

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const customer = await prisma.customer.findFirst({ where: scopedWhere({ id, deletedAt: null }, guard.user), select: { id: true } });
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  return NextResponse.json({ storeCredit: await getStoreCreditSummary(prisma, id) });
}

const adjustSchema = z.object({
  // + adds credit, − takes it away.
  amount: z.coerce
    .number({ error: "Enter an amount" })
    .refine((n) => n !== 0, "Enter an amount to add or take away")
    .refine((n) => Math.abs(n) <= 10_000_000, "That amount is too large"),
  reason: z.string().trim().min(3, "Give the reason for the adjustment").max(300),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("customer.credit.adjust");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = adjustSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await adjustStoreCredit(prisma, { customerId: id, amount: parsed.data.amount, reason: parsed.data.reason, actorId: guard.user.id, request });
    return NextResponse.json({ storeCredit: await getStoreCreditSummary(prisma, id) }, { status: 201 });
  } catch (error) {
    if (error instanceof StoreCreditError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
