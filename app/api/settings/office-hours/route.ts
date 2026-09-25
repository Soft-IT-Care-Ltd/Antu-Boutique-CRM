import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { OFFICE_HOURS_SETTING_KEY, officeHoursSchema } from "@/lib/attendance/office-hours";
import { getOfficeHours, saveOfficeHours } from "@/lib/attendance/settings";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";

// PRD §4.17 "office hours and late rule" — drives the late / half-day flags
// (PRD §4.14). A change applies to days recorded from then on; a day
// already recorded keeps the status it was given.

export async function GET() {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ officeHours: await getOfficeHours(prisma) });
}

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = officeHoursSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const before = await getOfficeHours(prisma);
  await saveOfficeHours(prisma, parsed.data, guard.user.id);
  const after = await getOfficeHours(prisma);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.update", entityType: "setting", entityId: OFFICE_HOURS_SETTING_KEY, before, after, request });
  return NextResponse.json({ officeHours: after });
}
