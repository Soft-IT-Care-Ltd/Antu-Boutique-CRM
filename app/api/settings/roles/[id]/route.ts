import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { rolePermissionsSchema, setRolePermissions, staffErrorResponse } from "@/lib/settings/staff";

// Replaces a role's permission template. Everyone in the role gets the new
// set on their next request (permissions are read from the DB each request);
// refused if it would leave nobody able to change settings and permissions.

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("permission.manage");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = rolePermissionsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    await setRolePermissions(prisma, guard.user.id, id, parsed.data.keys, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
