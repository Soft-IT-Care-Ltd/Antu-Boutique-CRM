import { NextResponse, type NextRequest } from "next/server";

import { auditFilterSchema, listAuditLogs } from "@/lib/audit/queries";
import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";

// P4.4 — the audit log, newest first. ADMIN only (audit.view).
export async function GET(request: NextRequest) {
  const guard = await requirePermission("audit.view");
  if (!guard.ok) return guard.response;
  const parsed = auditFilterSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid filter" }, { status: 400 });
  return NextResponse.json(await listAuditLogs(prisma, parsed.data, await can(guard.user, "product.cost.view")));
}
