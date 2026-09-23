import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { listCourierReturns } from "@/lib/courier/queries";
import { zodError } from "@/lib/courier/route-errors";

// Returns waiting for kept-items marking / a Packing condition check (open),
// or already checked (completed). No money in these rows.
const querySchema = z.object({
  status: z.enum(["open", "completed"]).default("open"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["courier.return_check", "courier.reconcile", "courier.manage"]);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return zodError(parsed.error.issues);
  return NextResponse.json(await listCourierReturns(guard.user, parsed.data));
}
