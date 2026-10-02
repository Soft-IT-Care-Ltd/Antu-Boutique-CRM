import "server-only";

import type { Prisma } from "@prisma/client";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { getEffectivePermissions, viewLevel } from "@/lib/auth/permissions";
import { attendanceRosterWhere, orderTakerWhere, salesFloorWhere } from "@/lib/auth/rosters";
import { buildScopeWhere, levelScopeWhere, type ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { ReportKey } from "@/lib/reports/catalog";

// Who may run which report, and whose data it holds. Every report needs
// report.view (the Reports section) plus the permission of the module its
// numbers come from — a report never shows what that module's own screen
// wouldn't. The data is then scoped server-side exactly like the module:
//
// • Orders, leads, customers, courier, collection, exchanges: by role
//   (lib/auth/scope.ts buildScopeWhere) — an executive their own, a team
//   leader their team's (CLAUDE.md rule 6).
// • Team performance and attendance: by the *_all / _team / _own level the
//   user holds (target.view_*, attendance.view_*), like P4.2's screens.
//
// Cost columns are a separate question (product.cost.view) answered in
// lib/reports/run.ts.

const ORDER_VIEW: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

type Rule = { any?: PermissionKey[]; all?: PermissionKey[] };

const RULES: Record<ReportKey, Rule[]> = {
  sales: [{ any: ORDER_VIEW }],
  leads: [{ any: ["lead.view_own", "lead.view_team", "lead.view_all"] }],
  team: [{ any: ["target.view_own", "target.view_team", "target.view_all"] }],
  stock: [{ any: ["inventory.view"] }],
  sets: [{ any: ["product.view"] }],
  courier: [{ any: ["courier.view", "courier.reconcile"] }],
  collections: [{ any: ["payment.view"] }],
  expense: [{ any: ["expense.view"] }],
  // PRD §4.12 / §3: Admin and Manager only.
  pl: [{ all: ["report.pl.view", "product.cost.view"] }],
  attendance: [{ any: ["attendance.view_own", "attendance.view_team", "attendance.view_all"] }],
  cancellations: [{ any: ORDER_VIEW }],
  customers: [{ any: ["customer.view_own", "customer.view_team", "customer.view_all"] }, { any: ORDER_VIEW }],
  exchanges: [{ any: ["exchange.view"] }],
  channels: [{ any: ORDER_VIEW }],
  stockouts: [{ any: ORDER_VIEW }],
};

function allowed(held: Set<PermissionKey>, key: ReportKey): boolean {
  if (!held.has("report.view")) return false;
  return RULES[key].every((rule) => (!rule.any || rule.any.some((p) => held.has(p))) && (!rule.all || rule.all.every((p) => held.has(p))));
}

export async function canRunReport(user: SessionUser, key: ReportKey): Promise<boolean> {
  return allowed(await getEffectivePermissions(user.id), key);
}

export async function runnableReports(user: SessionUser, keys: readonly ReportKey[]): Promise<ReportKey[]> {
  const held = await getEffectivePermissions(user.id);
  return keys.filter((k) => allowed(held, k));
}

/** The view level of a level-scoped report (null for the role-scoped ones). */
export async function reportLevel(user: SessionUser, key: ReportKey): Promise<ViewLevel | null> {
  if (key === "team") return viewLevel(user, { all: "target.view_all", team: "target.view_team", own: "target.view_own" });
  if (key === "attendance") return viewLevel(user, { all: "attendance.view_all", team: "attendance.view_team", own: "attendance.view_own" });
  return null;
}

/** How far this user sees for a report: everyone, one team, or just themself. */
export function reach(user: SessionUser, level: ViewLevel | null): ViewLevel {
  if (level) return level === "team" && !user.teamId ? "own" : level;
  const scope = buildScopeWhere(user);
  if (Object.keys(scope).length === 0) return "all";
  return "teamId" in scope ? "team" : "own";
}

/** The people a report's person filter lists — never anyone outside the user's scope. */
export function peopleWhere(user: SessionUser, key: ReportKey, level: ViewLevel | null): Prisma.UserWhereInput {
  const base = key === "attendance" ? attendanceRosterWhere : key === "team" ? salesFloorWhere : orderTakerWhere;
  const scope = level ? levelScopeWhere(user, level, { ownerField: "id" }) : buildScopeWhere(user, { ownerField: "id" });
  return { AND: [base, scope as Prisma.UserWhereInput] };
}
