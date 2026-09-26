import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { overridesSchema, setUserOverrides, staffErrorResponse } from "@/lib/settings/staff";

// PRD §3.1 per-user permission overrides — permission.manage only.

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("permission.manage");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = overridesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await setUserOverrides(prisma, guard.user.id, id, parsed.data.overrides, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
