import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, dayString, idString } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { ALL_PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import { listPayments, paymentQueueCounts } from "@/lib/payments/queries";
import { PAYMENT_LIST_VIEWS, REFUND_STATUS_VALUES } from "@/lib/payments/types";

// PRD §4.10 — the verification queue (view=unverified, oldest first), payment
// history, and refunds. Scoped through the order (lib/payments/queries.ts).
const querySchema = z.object({
  view: z.enum(PAYMENT_LIST_VIEWS).default("unverified"),
  refundStatus: z.enum(REFUND_STATUS_VALUES).optional(),
  method: z.enum(ALL_PAYMENT_METHOD_VALUES).optional(),
  walletId: idString.optional(),
  from: dayString.optional(),
  to: dayString.optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("payment.view");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const { from, to, q, ...rest } = parsed.data;
  const [result, counts] = await Promise.all([
    listPayments(guard.user, {
      ...rest,
      q: q || undefined,
      from: from ? dhakaDayStartUtc(from) : undefined,
      to: to ? dhakaDayStartUtc(to, 1) : undefined,
    }),
    paymentQueueCounts(guard.user),
  ]);
  return NextResponse.json({ ...result, counts });
}
