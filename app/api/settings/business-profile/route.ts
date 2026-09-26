import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { getBusinessProfile, saveBusinessProfile } from "@/lib/settings/business-profile";
import { BUSINESS_PROFILE_SETTING_KEY, businessProfileSchema } from "@/lib/settings/business-profile-shape";

// PRD §4.17 business profile — printed on every invoice, packing slip and
// showroom receipt generated from now on. Invoices already generated are
// files and keep what they printed. The logo has its own route.

export async function GET() {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ profile: await getBusinessProfile(prisma) });
}

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = businessProfileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const before = await getBusinessProfile(prisma);
  const after = { ...parsed.data, logoPath: before.logoPath };
  await saveBusinessProfile(prisma, after, guard.user.id);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.update", entityType: "setting", entityId: BUSINESS_PROFILE_SETTING_KEY, before, after, request });
  return NextResponse.json({ profile: after });
}
