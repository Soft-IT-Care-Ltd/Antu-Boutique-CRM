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

// ---------------------------------------------------------------------------
// P5.2 — staff and permission editing (Settings → Users, Roles & permissions)
// ---------------------------------------------------------------------------

/** What it takes to run the system: edit settings AND hand out permissions. */
export const ADMINISTRATION_KEYS: PermissionKey[] = ["settings.manage", "permission.manage"];

/**
 * Keys in `target` the actor does not hold. Someone may only create, edit,
 * reset or deactivate a person — or hand out a role — whose permissions are
 * all their own, unless they hold permission.manage. Without this a Manager
 * (user.edit) could reset the owner's password, or make themselves Admin.
 */
export function permissionsBeyond(actor: ReadonlySet<PermissionKey>, target: Iterable<PermissionKey>): PermissionKey[] {
  if (actor.has("permission.manage")) return [];
  return [...new Set(target)].filter((key) => !actor.has(key));
}

/** A role's template permissions as stored (the DB, not ROLE_TEMPLATES — Settings edits it). */
export async function loadRolePermissions(db: Db, roleId: string): Promise<Set<PermissionKey>> {
  const rows = await db.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { key: true } } } });
  return new Set(rows.map((r) => r.permission.key as PermissionKey));
}

/**
 * How many active people could still run the system. Every change that can
 * take permissions away (a role's permissions, a user's role or overrides,
 * deactivating someone) checks this inside its transaction and refuses a
 * change that would leave nobody — the owner must never lock themselves out.
 */
export async function countAdministrators(db: Db): Promise<number> {
  const keys = ADMINISTRATION_KEYS as string[];
  // One query for everyone: role grants and the person's overrides for just these keys.
  const users = await db.user.findMany({
    where: { isActive: true },
    select: {
      role: { select: { permissions: { where: { permission: { key: { in: keys } } }, select: { permission: { select: { key: true } } } } } },
      permissionOverrides: { where: { permission: { key: { in: keys } } }, select: { effect: true, permission: { select: { key: true } } } },
    },
  });
  return users.filter((user) => {
    const held = new Set(user.role.permissions.map((rp) => rp.permission.key));
    for (const o of user.permissionOverrides) {
      if (o.effect === "GRANT") held.add(o.permission.key);
      else held.delete(o.permission.key);
    }
    return keys.every((key) => held.has(key));
  }).length;
}
