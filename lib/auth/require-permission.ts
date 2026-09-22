import "server-only";

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { can } from "@/lib/auth/permissions";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import type { SessionUser } from "@/lib/auth/types";

type GuardOk = { ok: true; user: SessionUser };
type GuardFail = { ok: false; response: NextResponse };

/**
 * Route guard for API handlers.
 *
 *   const guard = await requirePermission("order.create");
 *   if (!guard.ok) return guard.response;
 *   const { user } = guard;
 */
export async function requirePermission(
  permission: PermissionKey | PermissionKey[],
  mode: "any" | "all" = "any",
): Promise<GuardOk | GuardFail> {
  const session = await auth();
  const sessionUser = session?.user;

  if (!sessionUser) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const user: SessionUser = {
    id: sessionUser.id,
    role: sessionUser.role,
    teamId: sessionUser.teamId,
  };

  const allowed = await can(user, permission, mode);
  if (!allowed) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { ok: true, user };
}
