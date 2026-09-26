import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { passwordSchema, resetPassword, staffErrorResponse } from "@/lib/settings/staff";

// PRD §4.1 "admin can reset": sets a temporary password the person must
// change at their next sign-in, and clears any lock-out.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("user.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = z.object({ password: passwordSchema }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await resetPassword(prisma, guard.user.id, id, parsed.data.password, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
