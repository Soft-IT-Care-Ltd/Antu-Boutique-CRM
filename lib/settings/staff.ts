import "server-only";

import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { writeAuditLogWith } from "@/lib/audit/log";
import { countAdministrators, loadEffectivePermissions, loadRolePermissions, permissionsBeyond } from "@/lib/auth/permissions";
import { PERMISSIONS, type PermissionKey } from "@/lib/auth/permission-definitions";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { withTx, type Db } from "@/lib/db/tx";
import { dayString } from "@/lib/finance/http";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";

// PRD §4.1 / §4.17 — staff accounts, teams, role permissions and per-user
// overrides (Settings → Users, Roles & permissions). Every change is one
// transaction with its audit row (PRD §3.1: "user/permission change").
//
// Two guards run on every change, both worked out from permissions, never
// from role names (CLAUDE.md: permission decisions live in lib/auth):
//   - no escalation: without permission.manage you can only touch people,
//     and hand out roles, whose permissions you hold yourself
//     (permissionsBeyond) — so user.edit can't reset the owner's password;
//   - no lock-out: after the change at least one active person can still
//     edit settings and permissions (countAdministrators).

export class StaffError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const BCRYPT_ROUNDS = 12;
const ALL_KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));

export const passwordSchema = z.string().min(8, "Passwords are at least 8 characters").max(100);

const phoneSchema = z
  .string()
  .trim()
  .refine(isValidBdPhone, "Enter a Bangladeshi mobile number (e.g. 017XXXXXXXX)")
  .transform(normalizeBdPhone);

export const userFieldsSchema = z.object({
  name: z.string().trim().min(2, "Enter the person's name").max(80),
  phone: phoneSchema,
  email: z
    .string()
    .trim()
    .max(120)
    .transform((v) => v.toLowerCase())
    .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address")
    .nullish(),
  roleId: z.string().trim().min(1, "Pick a role"),
  teamId: z.string().trim().min(1).nullish(),
  joinDate: dayString,
});

export const createUserSchema = userFieldsSchema.extend({ password: passwordSchema });

export const updateUserSchema = userFieldsSchema.partial().extend({
  isActive: z.boolean().optional(),
  /** Clears a lock-out from failed logins (PRD §4.1: 5 attempts → 15 minutes). */
  unlock: z.literal(true).optional(),
});

export const overridesSchema = z.object({
  overrides: z
    .array(
      z.object({
        key: z.string().refine((k) => ALL_KEYS.has(k), "Unknown permission"),
        effect: z.enum(["GRANT", "REVOKE"]),
        reason: z.string().trim().max(200).nullish(),
      }),
    )
    .max(PERMISSIONS.length)
    .refine((list) => new Set(list.map((o) => o.key)).size === list.length, "Each permission may be overridden once"),
});

export const rolePermissionsSchema = z.object({
  keys: z
    .array(z.string().refine((k) => ALL_KEYS.has(k), "Unknown permission"))
    .max(PERMISSIONS.length)
    .transform((keys) => [...new Set(keys)] as PermissionKey[]),
});

export const teamSchema = z.object({
  name: z.string().trim().min(2, "Give the team a name").max(60),
  leaderId: z.string().trim().min(1).nullish(),
  isActive: z.boolean().optional(),
});

type CreateUserInput = z.infer<typeof createUserSchema>;
type UpdateUserInput = z.infer<typeof updateUserSchema>;

const userAuditShape = (u: { name: string; phone: string; email: string | null; roleId: string; teamId: string | null; isActive: boolean; joinDate: Date }) => ({
  name: u.name,
  phone: u.phone,
  email: u.email,
  roleId: u.roleId,
  teamId: u.teamId,
  isActive: u.isActive,
  joinDate: u.joinDate.toISOString(),
});

async function assertNoEscalation(tx: Prisma.TransactionClient, actorId: string, target: Iterable<PermissionKey>, what: string) {
  const actor = await loadEffectivePermissions(tx, actorId);
  const beyond = permissionsBeyond(actor, target);
  if (beyond.length > 0) throw new StaffError(`${what} has permissions you don't hold (${beyond.slice(0, 3).join(", ")}${beyond.length > 3 ? "…" : ""}). Ask someone who can manage permissions.`, 403);
}

async function assertAdministratorRemains(tx: Prisma.TransactionClient) {
  if ((await countAdministrators(tx)) === 0) {
    throw new StaffError("That would leave nobody who can change settings and permissions. Give another active person that access first.", 409);
  }
}

async function assertUniqueContact(tx: Prisma.TransactionClient, phone: string | undefined, email: string | null | undefined, exceptId?: string) {
  if (phone) {
    const clash = await tx.user.findUnique({ where: { phone }, select: { id: true, name: true } });
    if (clash && clash.id !== exceptId) throw new StaffError(`${clash.name} already signs in with ${phone}`, 409);
  }
  if (email) {
    const clash = await tx.user.findUnique({ where: { email }, select: { id: true, name: true } });
    if (clash && clash.id !== exceptId) throw new StaffError(`${clash.name} already signs in with ${email}`, 409);
  }
}

async function assertTeam(tx: Prisma.TransactionClient, teamId: string | null | undefined) {
  if (!teamId) return;
  const team = await tx.team.findUnique({ where: { id: teamId }, select: { isActive: true } });
  if (!team || !team.isActive) throw new StaffError("Pick an active team");
}

export async function createUser(db: Db, actorId: string, input: CreateUserInput, request?: Request) {
  return withTx(db, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: input.roleId }, select: { id: true, label: true } });
    if (!role) throw new StaffError("Pick a role");
    await assertNoEscalation(tx, actorId, await loadRolePermissions(tx, role.id), `The ${role.label} role`);
    await assertUniqueContact(tx, input.phone, input.email || null);
    await assertTeam(tx, input.teamId);

    const user = await tx.user.create({
      data: {
        name: input.name,
        phone: input.phone,
        email: input.email || null,
        roleId: role.id,
        teamId: input.teamId || null,
        joinDate: dhakaDayStartUtc(input.joinDate),
        passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        // PRD §4.1: forced password change on first login.
        mustChangePassword: true,
      },
    });
    await writeAuditLogWith(tx, { actorId, action: "user.create", entityType: "user", entityId: user.id, after: userAuditShape(user), request });
    return user;
  });
}

export async function updateUser(db: Db, actorId: string, userId: string, input: UpdateUserInput, request?: Request) {
  return withTx(db, async (tx) => {
    const before = await tx.user.findUnique({ where: { id: userId }, include: { ledTeam: { select: { id: true } } } });
    if (!before) throw new StaffError("User not found", 404);
    await assertNoEscalation(tx, actorId, await loadEffectivePermissions(tx, userId), before.name);
    if (input.isActive === false && userId === actorId) throw new StaffError("You can't deactivate your own account.");

    if (input.isActive !== undefined && input.isActive !== before.isActive) {
      const actor = await loadEffectivePermissions(tx, actorId);
      if (!actor.has("user.delete")) throw new StaffError("Deactivating a person needs the \"Deactivate staff accounts\" permission.", 403);
    }
    if (input.roleId && input.roleId !== before.roleId) {
      const role = await tx.role.findUnique({ where: { id: input.roleId }, select: { id: true, label: true } });
      if (!role) throw new StaffError("Pick a role");
      await assertNoEscalation(tx, actorId, await loadRolePermissions(tx, role.id), `The ${role.label} role`);
    }
    await assertUniqueContact(tx, input.phone, input.email || null, userId);
    if (input.teamId !== undefined && input.teamId !== before.teamId) await assertTeam(tx, input.teamId);

    const after = await tx.user.update({
      where: { id: userId },
      data: {
        name: input.name,
        phone: input.phone,
        email: input.email === undefined ? undefined : input.email || null,
        roleId: input.roleId,
        teamId: input.teamId === undefined ? undefined : input.teamId || null,
        joinDate: input.joinDate ? dhakaDayStartUtc(input.joinDate) : undefined,
        isActive: input.isActive,
        ...(input.unlock ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
    });
    // A leader who leaves their team (or the company) stops leading it.
    if (before.ledTeam && (after.teamId !== before.ledTeam.id || !after.isActive)) {
      await tx.team.update({ where: { id: before.ledTeam.id }, data: { leaderId: null } });
    }
    await assertAdministratorRemains(tx);

    const action = input.isActive === false && before.isActive ? "user.deactivate" : input.isActive === true && !before.isActive ? "user.reactivate" : "user.update";
    await writeAuditLogWith(tx, {
      actorId,
      action,
      entityType: "user",
      entityId: userId,
      before: userAuditShape(before),
      after: { ...userAuditShape(after), ...(input.unlock ? { unlocked: true } : {}) },
      request,
    });
    return after;
  });
}

/** PRD §4.1 "admin can reset": a new temporary password, changed at next sign-in. Never logged. */
export async function resetPassword(db: Db, actorId: string, userId: string, password: string, request?: Request) {
  return withTx(db, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
    if (!user) throw new StaffError("User not found", 404);
    await assertNoEscalation(tx, actorId, await loadEffectivePermissions(tx, userId), user.name);
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await writeAuditLogWith(tx, { actorId, action: "user.password_reset", entityType: "user", entityId: userId, after: { mustChangePassword: true }, request });
  });
}

/** PRD §3.1 per-user overrides: GRANT adds to the role, REVOKE takes away. Replaces the person's whole list. */
export async function setUserOverrides(db: Db, actorId: string, userId: string, overrides: z.infer<typeof overridesSchema>["overrides"], request?: Request) {
  return withTx(db, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, permissionOverrides: { select: { effect: true, reason: true, permission: { select: { key: true } } } } },
    });
    if (!user) throw new StaffError("User not found", 404);
    const permissionRows = await tx.permission.findMany({ where: { key: { in: overrides.map((o) => o.key) } }, select: { id: true, key: true } });
    const idByKey = new Map(permissionRows.map((p) => [p.key, p.id]));
    const missing = overrides.find((o) => !idByKey.has(o.key));
    if (missing) throw new StaffError(`Permission ${missing.key} isn't in the database yet — run the seed to add new permissions.`, 409);

    await tx.userPermissionOverride.deleteMany({ where: { userId } });
    if (overrides.length > 0) {
      await tx.userPermissionOverride.createMany({
        data: overrides.map((o) => ({ userId, permissionId: idByKey.get(o.key)!, effect: o.effect, reason: o.reason || null })),
      });
    }
    await assertAdministratorRemains(tx);

    const shape = (list: { key: string; effect: string; reason?: string | null }[]) =>
      [...list].sort((a, b) => a.key.localeCompare(b.key)).map((o) => ({ key: o.key, effect: o.effect, reason: o.reason || null }));
    await writeAuditLogWith(tx, {
      actorId,
      action: "user.permission_overrides",
      entityType: "user",
      entityId: userId,
      before: shape(user.permissionOverrides.map((o) => ({ key: o.permission.key, effect: o.effect, reason: o.reason }))),
      after: shape(overrides),
      request,
    });
  });
}

/** Replaces a role's permission template (PRD §4.17 "roles and permissions"). Applies to everyone in the role on their next request. */
export async function setRolePermissions(db: Db, actorId: string, roleId: string, keys: PermissionKey[], request?: Request) {
  return withTx(db, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, select: { id: true } });
    if (!role) throw new StaffError("Role not found", 404);
    const before = await loadRolePermissions(tx, roleId);
    const permissionRows = await tx.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
    if (permissionRows.length !== keys.length) throw new StaffError("Some of those permissions aren't in the database yet — run the seed to add new permissions.", 409);

    await tx.rolePermission.deleteMany({ where: { roleId } });
    await tx.rolePermission.createMany({ data: permissionRows.map((p) => ({ roleId, permissionId: p.id })) });
    await assertAdministratorRemains(tx);

    const after = new Set(keys);
    await writeAuditLogWith(tx, {
      actorId,
      action: "role.permissions_update",
      entityType: "role",
      entityId: roleId,
      before: { keys: [...before].sort() },
      after: { keys: [...after].sort(), added: [...after].filter((k) => !before.has(k)).sort(), removed: [...before].filter((k) => !after.has(k)).sort() },
      request,
    });
  });
}

// ---------------------------------------------------------------------------
// Teams (PRD §4.1: name, team leader, members)
// ---------------------------------------------------------------------------

/** The leader leads the team they belong to: a Team Leader's scope is their own team (lib/auth/scope.ts). */
async function makeLeader(tx: Prisma.TransactionClient, teamId: string, leaderId: string) {
  const leader = await tx.user.findUnique({ where: { id: leaderId }, select: { isActive: true, teamId: true, ledTeam: { select: { id: true, name: true } } } });
  if (!leader || !leader.isActive) throw new StaffError("Pick an active person to lead the team");
  if (leader.ledTeam && leader.ledTeam.id !== teamId) throw new StaffError(`That person already leads ${leader.ledTeam.name}`, 409);
  if (leader.teamId !== teamId) await tx.user.update({ where: { id: leaderId }, data: { teamId } });
}

export async function createTeam(db: Db, actorId: string, input: z.infer<typeof teamSchema>, request?: Request) {
  return withTx(db, async (tx) => {
    const team = await tx.team.create({ data: { name: input.name, isActive: input.isActive ?? true } });
    if (input.leaderId) {
      await makeLeader(tx, team.id, input.leaderId);
      await tx.team.update({ where: { id: team.id }, data: { leaderId: input.leaderId } });
    }
    await writeAuditLogWith(tx, { actorId, action: "team.create", entityType: "team", entityId: team.id, after: { name: team.name, leaderId: input.leaderId ?? null }, request });
    return team;
  });
}

export async function updateTeam(db: Db, actorId: string, teamId: string, input: Partial<z.infer<typeof teamSchema>>, request?: Request) {
  return withTx(db, async (tx) => {
    const before = await tx.team.findUnique({ where: { id: teamId }, include: { _count: { select: { members: { where: { isActive: true } } } } } });
    if (!before) throw new StaffError("Team not found", 404);
    if (input.isActive === false && before._count.members > 0) {
      throw new StaffError(`${before.name} still has ${before._count.members} active member${before._count.members === 1 ? "" : "s"} — move them to another team first.`, 409);
    }
    if (input.leaderId) await makeLeader(tx, teamId, input.leaderId);
    const after = await tx.team.update({
      where: { id: teamId },
      data: { name: input.name, isActive: input.isActive, leaderId: input.leaderId === undefined ? undefined : input.leaderId || null },
    });
    await writeAuditLogWith(tx, {
      actorId,
      action: "team.update",
      entityType: "team",
      entityId: teamId,
      before: { name: before.name, leaderId: before.leaderId, isActive: before.isActive },
      after: { name: after.name, leaderId: after.leaderId, isActive: after.isActive },
      request,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Reads for the Settings screens
// ---------------------------------------------------------------------------

export type StaffListQuery = { q?: string; roleId?: string; status: "active" | "inactive" | "all"; page: number; pageSize: number };

export async function listStaff(db: Db, query: StaffListQuery) {
  const where: Prisma.UserWhereInput = {
    ...(query.status === "all" ? {} : { isActive: query.status === "active" }),
    ...(query.roleId ? { roleId: query.roleId } : {}),
    ...(query.q
      ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { phone: { contains: query.q.replace(/[\s-]/g, "") } }, { email: { contains: query.q, mode: "insensitive" } }] }
      : {}),
  };
  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        mustChangePassword: true,
        lockedUntil: true,
        lastLoginAt: true,
        joinDate: true,
        role: { select: { id: true, name: true, label: true } },
        team: { select: { id: true, name: true } },
        ledTeam: { select: { id: true } },
        permissionOverrides: { select: { effect: true, reason: true, permission: { select: { key: true } } } },
      },
    }),
  ]);
  const now = new Date();
  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: users.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      email: u.email,
      isActive: u.isActive,
      mustChangePassword: u.mustChangePassword,
      locked: Boolean(u.lockedUntil && u.lockedUntil > now),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      joinDate: u.joinDate.toISOString(),
      role: u.role,
      team: u.team,
      leadsTeam: Boolean(u.ledTeam),
      overrides: u.permissionOverrides.map((o) => ({ key: o.permission.key, effect: o.effect, reason: o.reason })),
    })),
  };
}

export type StaffListItem = Awaited<ReturnType<typeof listStaff>>["items"][number];

export async function listTeams(db: Db) {
  const teams = await db.team.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      isActive: true,
      leader: { select: { id: true, name: true } },
      members: { where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } },
    },
  });
  return teams;
}

export type TeamView = Awaited<ReturnType<typeof listTeams>>[number];

export async function listRolesWithPermissions(db: Db) {
  const roles = await db.role.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      label: true,
      description: true,
      permissions: { select: { permission: { select: { key: true } } } },
      _count: { select: { users: { where: { isActive: true } } } },
    },
  });
  return roles.map((r) => ({ id: r.id, name: r.name, label: r.label, description: r.description, activeUsers: r._count.users, keys: r.permissions.map((p) => p.permission.key as PermissionKey) }));
}

export type RoleView = Awaited<ReturnType<typeof listRolesWithPermissions>>[number];

/** StaffError → its status and message; anything else is a real 500. */
export function staffErrorResponse(error: unknown) {
  if (error instanceof StaffError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}
