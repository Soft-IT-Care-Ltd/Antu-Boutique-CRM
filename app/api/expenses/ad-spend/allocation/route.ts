import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { getAdAllocationMethod, getDayAllocation } from "@/lib/expenses/ad-allocation";
import { AD_ALLOCATION_SETTING_KEY, AD_ALLOCATION_VALUES } from "@/lib/expenses/constants";
import { badRequest, dayString } from "@/lib/finance/http";
import { todayInDhaka } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { setSetting } from "@/lib/settings/get";

// How a day's ad spend splits over that day's confirmed orders, and the
// setting that picks equal-split vs by-order-value (PRD §4.12).

export async function GET(request: NextRequest) {
  const guard = await requirePermission("expense.view");
  if (!guard.ok) return guard.response;
  const parsed = z.object({ day: dayString.optional() }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  return NextResponse.json({ allocation: await getDayAllocation(prisma, parsed.data.day ?? todayInDhaka()) });
}

// The allocation method changes every order's profit — a business setting (Admin).
export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = z.object({ method: z.enum(AD_ALLOCATION_VALUES) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const before = await getAdAllocationMethod(prisma);
  await setSetting(AD_ALLOCATION_SETTING_KEY, parsed.data.method, guard.user.id);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.update", entityType: "setting", entityId: AD_ALLOCATION_SETTING_KEY, before: { value: before }, after: { value: parsed.data.method }, request });
  return NextResponse.json({ method: parsed.data.method });
}
