import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { staffErrorResponse, updateUser, updateUserSchema } from "@/lib/settings/staff";

// Edit a person: details, role, team, unlock, deactivate (needs user.delete
// too — checked in the service). Deactivated people are signed out on their
// next request (lib/auth/session-refresh.ts); accounts are never deleted,
// because orders, payments and the audit log point at them.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("user.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = updateUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const user = await updateUser(prisma, guard.user.id, id, parsed.data, request);
    return NextResponse.json({ user: { id: user.id, name: user.name, isActive: user.isActive } });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
