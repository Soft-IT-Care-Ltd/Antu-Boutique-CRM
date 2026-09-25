import type { Prisma, RoleName } from "@prisma/client";

// Who a module counts, as opposed to who may see it. These are query
// filters, not permission checks (those stay in lib/auth/permissions.ts),
// and they live here so role names are never compared anywhere else.

/**
 * PRD §4.13 targets and the leaderboard rank the people who sell online:
 * sales executives and team leaders. The owner, managers, Packing,
 * Accounts and the showroom till are not on it.
 */
export const SALES_FLOOR_ROLES: RoleName[] = ["SALES_EXECUTIVE", "TEAM_LEADER"];

export const salesFloorWhere: Prisma.UserWhereInput = { isActive: true, role: { name: { in: SALES_FLOOR_ROLES } } };

/**
 * PRD §4.14 attendance covers every active member of staff except the
 * owner (Admin), who doesn't check in and would otherwise show absent
 * every day.
 */
export const attendanceRosterWhere: Prisma.UserWhereInput = { isActive: true, role: { name: { not: "ADMIN" } } };

/**
 * P4.4 reports — the people a sales report can be filtered by: everyone who
 * takes orders (the sales floor, the showroom till, and the owner or a
 * manager who rings one up). Packing and Accounts never create orders.
 * Inactive people stay listed: their past sales are still in the period.
 */
export const orderTakerWhere: Prisma.UserWhereInput = { role: { name: { notIn: ["PACKING", "ACCOUNTS"] } } };
