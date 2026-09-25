import "server-only";

import { cache } from "react";

import type { Db } from "@/lib/db/tx";
import { prisma } from "@/lib/prisma";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import type { ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";

// lib/auth/permissions.ts is the ONLY place permission decisions get made.
// Every route guard, <Can> check and scope helper routes through here —
// never compare `user.role === "ADMIN"` anywhere else in the codebase.
//
// Deliberately free of any NextAuth import: `auth()` pulls in next-auth's
// full runtime (fine inside Next.js, but it breaks module resolution under
// plain Node test runners). The one caller that needs a session,
// requirePermission() in lib/auth/require-permission.ts, imports `auth`
// itself and calls `can()` from here.
//
// Effective permissions = role template (role -> role_permissions, DB-driven
// so Settings can edit it later) with per-user overrides applied on top
// (GRANT adds, REVOKE removes). Memoized per request with React's cache()
// so a page that renders <Can> a dozen times only hits the DB once.
export const getEffectivePermissions = cache((userId: string): Promise<Set<PermissionKey>> => loadEffectivePermissions(prisma, userId));

/**
 * Uncached, client-injectable form (tests pass a rolled-back transaction).
 * A deactivated user holds no permissions at all — defence in depth behind
 * the session re-check in lib/auth/session-refresh.ts.
 */
export async function loadEffectivePermissions(db: Db, userId: string): Promise<Set<PermissionKey>> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      isActive: true,
      role: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
      permissionOverrides: {
        select: { effect: true, permission: { select: { key: true } } },
      },
    },
  });

  if (!user || !user.isActive) return new Set();

  const permissions = new Set<PermissionKey>(
    user.role.permissions.map((rp) => rp.permission.key as PermissionKey),
  );

  for (const override of user.permissionOverrides) {
    const key = override.permission.key as PermissionKey;
    if (override.effect === "GRANT") permissions.add(key);
    else permissions.delete(key);
  }

  return permissions;
}

type CanMode = "any" | "all";

/** Core check: does this user hold the given permission(s)? */
export async function can(
  user: SessionUser | null | undefined,
  permission: PermissionKey | PermissionKey[],
  mode: CanMode = "any",
): Promise<boolean> {
  if (!user) return false;

  const permissions = await getEffectivePermissions(user.id);
  const keys = Array.isArray(permission) ? permission : [permission];
  if (keys.length === 0) return true;

  return mode === "all" ? keys.every((k) => permissions.has(k)) : keys.some((k) => permissions.has(k));
}

/**
 * The widest view level the user holds out of an all / team / own trio
 * (e.g. attendance.view_all / _team / _own), or null for none. Feed the
 * result to levelScopedWhere() in lib/auth/scope.ts.
 */
export async function viewLevel(
  user: SessionUser,
  keys: { all: PermissionKey; team: PermissionKey; own: PermissionKey },
): Promise<ViewLevel | null> {
  const permissions = await getEffectivePermissions(user.id);
  if (permissions.has(keys.all)) return "all";
  if (permissions.has(keys.team)) return "team";
  if (permissions.has(keys.own)) return "own";
  return null;
}
