import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { badRequest, targetErrorResponse } from "@/lib/targets/http";
import { updateRule } from "@/lib/targets/rewards";
import { ruleSchema } from "@/lib/targets/validation";

// Edit a rule, or switch it off (isActive: false). Rules are never deleted:
// past awards keep their own copy of the rule either way.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("target.manage");
  if (!guard.ok) return guard.response;
  const id = z.string().cuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  const parsed = ruleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await updateRule(prisma, guard.user, id.data, parsed.data, { request });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return targetErrorResponse(error);
  }
}
