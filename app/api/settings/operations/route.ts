import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { getOperationsSettings, operationsSchema, saveOperationsSettings } from "@/lib/settings/operations";

// PRD §4.17 — order edit window, packing SLA and the low-stock default.
// Each takes effect on the next request that reads it: an order's edit
// window is measured from its creation with the CURRENT length.

export async function GET() {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ settings: await getOperationsSettings(prisma) });
}

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = operationsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const before = await getOperationsSettings(prisma);
  await saveOperationsSettings(prisma, parsed.data, guard.user.id);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.update", entityType: "setting", entityId: "operations", before, after: parsed.data, request });
  return NextResponse.json({ settings: parsed.data });
}
