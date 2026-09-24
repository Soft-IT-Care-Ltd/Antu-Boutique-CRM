import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { badRequest, dayRange, dayString } from "@/lib/finance/http";
import { ORDER_CHANNEL_VALUES } from "@/lib/orders/constants";
import { prisma } from "@/lib/prisma";
import { getExchangeReport } from "@/lib/returns/queries";

// PRD §4.11 exchange report: by reason, product/variant and executive, scoped
// like every order report. The courier charge we bore is cost data —
// stripped for roles without product.cost.view (CLAUDE.md rule 5).
const querySchema = z
  .object({ from: dayString.optional(), to: dayString.optional(), channel: z.enum(ORDER_CHANNEL_VALUES).optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "The start date must be on or before the end date");

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["return.view", "exchange.view"]);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const range = dayRange(parsed.data.from, parsed.data.to);
  const report = await getExchangeReport(prisma, guard.user, range.from, range.to, parsed.data.channel);
  return NextResponse.json(await stripCostFieldsForUser({ report, fromDay: range.fromDay, toDay: range.toDay }, guard.user));
}
