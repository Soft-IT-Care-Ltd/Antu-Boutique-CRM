import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { LEAD_VIEW_PERMISSIONS } from "@/lib/leads/http";
import { listDueFollowUps } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

// "My follow-ups due today" (PRD §4.5): open reminders due by tonight,
// overdue first, within the caller's scope.
export async function GET() {
  const guard = await requirePermission(LEAD_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  return NextResponse.json(await listDueFollowUps(prisma, guard.user, { limit: 100 }));
}
