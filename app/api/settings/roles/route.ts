import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { PERMISSIONS } from "@/lib/auth/permission-definitions";
import { prisma } from "@/lib/prisma";
import { listRolesWithPermissions } from "@/lib/settings/staff";

// PRD §4.17 roles and permissions: each role's template, as stored.

export async function GET() {
  const guard = await requirePermission("permission.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ roles: await listRolesWithPermissions(prisma), permissions: PERMISSIONS });
}
