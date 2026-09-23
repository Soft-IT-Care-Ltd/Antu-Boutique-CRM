import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { codSummary, listAwaitingPayout, listDiscrepancies, listStatements } from "@/lib/courier/cod-queries";
import { zodError } from "@/lib/courier/route-errors";

// COD reconciliation board (PRD §4.9): parcels delivered but not yet paid out
// by the courier, statements/payouts, and the discrepancy list for ACCOUNTS.
const querySchema = z.object({
  view: z.enum(["awaiting", "statements", "discrepancies"]).default("awaiting"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("courier.reconcile");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return zodError(parsed.error.issues);
  const { view, ...page } = parsed.data;

  const [list, summary] = await Promise.all([
    view === "awaiting" ? listAwaitingPayout(guard.user, page) : view === "statements" ? listStatements(page) : listDiscrepancies(page),
    codSummary(guard.user),
  ]);
  return NextResponse.json({ view, ...list, summary });
}
