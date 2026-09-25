import { NextResponse, type NextRequest } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { badRequest, TARGET_VIEW_PERMISSIONS, targetErrorResponse } from "@/lib/targets/http";
import { createRule, listRules } from "@/lib/targets/rewards";
import { ruleSchema } from "@/lib/targets/validation";

// PRD §4.13 reward rules: threshold → reward. Everyone who sees targets
// sees the active rules (it's what they can earn); target.manage edits.

export async function GET() {
  const guard = await requirePermission(TARGET_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const manage = await can(guard.user, "target.manage");
  return NextResponse.json({ rules: await listRules(prisma, { includeInactive: manage }) });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("target.manage");
  if (!guard.ok) return guard.response;
  const parsed = ruleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const rule = await createRule(prisma, guard.user, parsed.data, { request });
    return NextResponse.json({ id: rule.id }, { status: 201 });
  } catch (error) {
    return targetErrorResponse(error);
  }
}
