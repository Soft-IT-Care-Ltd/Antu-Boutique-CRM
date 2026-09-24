import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest, idString } from "@/lib/finance/http";
import { transactionIdSchema } from "@/lib/orders/payment-validation";
import { setLineSchema } from "@/lib/sets/validation";
import { POS_TENDER_METHODS } from "@/lib/pos/constants";
import { getPosCashWalletId } from "@/lib/pos/drawer";
import { posErrorResponse } from "@/lib/pos/http";
import { listRecentPosSales } from "@/lib/pos/lookup";
import { createPosSale } from "@/lib/pos/sale";
import { prisma } from "@/lib/prisma";

// PRD §4.7 — POST completes a showroom sale (lib/pos/sale.ts); GET lists
// today's walk-in sales for the reprint panel, scoped like every order list.

const amount = z.coerce.number().min(0).max(100_000_000);

// No total, due_amount or cost field exists in this shape: the server prices
// the cart from the lines and the variants' own data (CLAUDE.md rules 1, 9).
const saleSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: idString,
        qty: z.coerce.number().int().min(1).max(999),
        unitPrice: amount,
        lineDiscount: amount.default(0),
        stockOverrideReason: z.string().trim().max(300).nullish(),
      }),
    )
    .max(100)
    .default([]),
  cartDiscount: amount.default(0),
  customer: z
    .object({ phone: z.string().trim().max(20), name: z.string().trim().max(150).nullish() })
    .nullish(),
  // P3.3 — outfit sets: the set, how many, and the size/colour picked for
  // each of its component products. Priced and exploded server-side.
  sets: z.array(setLineSchema).max(50).default([]),
  tenders: z
    .array(
      z.object({
        method: z.enum(POS_TENDER_METHODS),
        amount: z.coerce.number().positive("Each payment needs an amount").max(100_000_000),
        tendered: amount.nullish(),
        walletId: idString.nullish(),
        transactionId: transactionIdSchema.nullish(),
      }),
    )
    .max(6),
  note: z.string().trim().max(500).nullish(),
});

export async function POST(request: NextRequest) {
  const guard = await requirePermission("pos.sell");
  if (!guard.ok) return guard.response;
  const parsed = saleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const [cashWalletId, hasCostAccess, hasStockOverride, canCreateCustomer] = await Promise.all([
      getPosCashWalletId(prisma),
      can(guard.user, "product.cost.view"),
      can(guard.user, "order.stock_override"),
      can(guard.user, "customer.create"),
    ]);
    const sale = await createPosSale(prisma, { user: guard.user, cashWalletId, hasCostAccess, hasStockOverride, canCreateCustomer }, {
      ...parsed.data,
      tenders: parsed.data.tenders.map((t) => ({ ...t, transactionId: t.transactionId || null })),
    });
    return NextResponse.json(await stripCostFieldsForUser({ sale }, guard.user), { status: 201 });
  } catch (error) {
    return posErrorResponse(error);
  }
}

export async function GET() {
  const guard = await requirePermission("pos.sell");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ sales: await listRecentPosSales(prisma, guard.user) });
}
