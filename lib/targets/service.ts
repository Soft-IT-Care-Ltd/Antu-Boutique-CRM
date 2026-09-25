import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { salesFloorWhere } from "@/lib/auth/rosters";
import { levelScopeWhere, type ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { type LeaderboardSort } from "@/lib/targets/constants";
import { daysInMonth, daysLeftInMonth, dhakaMonth, MONTH_PATTERN, shiftMonth } from "@/lib/targets/month";
import { statsByTeam, statsByUser, statsOrEmpty } from "@/lib/targets/performance";
import { progressRatio, type Stats } from "@/lib/targets/stats";
import type { Leaderboard, LeaderboardRow, PersonProgress, Progress, StatsView, TargetBoard, TargetGoal, TargetPerson, TargetTeam, TeamLeaderboardRow, TeamProgress } from "@/lib/targets/types";

// PRD §4.13 — monthly targets per person and per team, their live
// progress, and the leaderboard.
//
// Scope comes from target.view_all / _team / _own (lib/auth/permissions.ts
// viewLevel): an executive sees their own target and their own row on the
// leaderboard (with their rank — never anyone else's numbers), a team
// leader their team, Admin/Manager everyone. Setting targets needs
// target.manage and is audit-logged (CLAUDE.md rule 7).

export class TargetError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type AuditContext = { request?: Request };

export function statsView(s: Stats): StatsView {
  return {
    salesValue: fromPaisa(s.salesPaisa),
    orderCount: s.orderCount,
    deliveredValue: fromPaisa(s.deliveredPaisa),
    delivered: s.delivered,
    returned: s.returned,
    inProgress: s.inProgress,
    deliveredRate: s.deliveredRate,
  };
}

type TargetRow = { id: string; orderCount: number | null; orderValue: Prisma.Decimal | null; note: string | null };

function goalView(t: TargetRow | null | undefined): TargetGoal | null {
  return t ? { id: t.id, orderCount: t.orderCount, orderValue: t.orderValue ? fromPaisa(toPaisa(t.orderValue)) : null, note: t.note } : null;
}

function progress(target: TargetRow | null | undefined, stats: Stats): Progress {
  return {
    target: goalView(target),
    stats: statsView(stats),
    valueProgress: target?.orderValue ? progressRatio(stats.salesPaisa, toPaisa(target.orderValue)) : null,
    countProgress: progressRatio(stats.orderCount, target?.orderCount),
  };
}

export async function isMonthLocked(db: Db, month: string): Promise<boolean> {
  return (await db.rewardEvaluation.count({ where: { month } })) > 0;
}

/** Sales-floor people this user can see, plus anyone in scope who has a target this month. */
async function peopleInScope(db: Db, user: SessionUser, level: ViewLevel, month: string) {
  const scope = levelScopeWhere(user, level, { ownerField: "id" }) as Prisma.UserWhereInput;
  return db.user.findMany({
    where: { AND: [scope, { OR: [salesFloorWhere, { salesTargets: { some: { month } } }] }] },
    select: { id: true, name: true, teamId: true, team: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
}

async function teamsInScope(db: Db, user: SessionUser, level: ViewLevel) {
  if (level === "own" || (level === "team" && !user.teamId)) return [];
  return db.team.findMany({
    where: { isActive: true, ...(level === "team" ? { id: user.teamId! } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

export async function getTargetBoard(db: Db, user: SessionUser, level: ViewLevel, month: string): Promise<TargetBoard> {
  const [people, teams, locked] = await Promise.all([peopleInScope(db, user, level, month), teamsInScope(db, user, level), isMonthLocked(db, month)]);
  const userIds = people.map((p) => p.id);
  const teamIds = teams.map((t) => t.id);
  const [targets, byUser, byTeam] = await Promise.all([
    db.salesTarget.findMany({ where: { month, OR: [{ userId: { in: userIds } }, { teamId: { in: teamIds } }] } }),
    statsByUser(db, month, userIds),
    teamIds.length ? statsByTeam(db, month, teamIds) : Promise.resolve(new Map<string, Stats>()),
  ]);
  const byUserTarget = new Map(targets.filter((t) => t.userId).map((t) => [t.userId!, t]));
  const byTeamTarget = new Map(targets.filter((t) => t.teamId).map((t) => [t.teamId!, t]));

  const peopleRows: PersonProgress[] = people.map((p) => ({
    userId: p.id,
    name: p.name,
    teamId: p.teamId,
    teamName: p.team?.name ?? null,
    ...progress(byUserTarget.get(p.id), statsOrEmpty(byUser, p.id)),
  }));
  const teamRows: TeamProgress[] = teams.map((t) => ({ teamId: t.id, name: t.name, ...progress(byTeamTarget.get(t.id), statsOrEmpty(byTeam, t.id)) }));

  return { month, daysLeft: daysLeftInMonth(month), daysInMonth: daysInMonth(month), locked, people: peopleRows, teams: teamRows };
}

/** One person's progress this month — the dashboard gauge. Null when they have no target and aren't on the sales floor. */
export async function getMyProgress(db: Db, user: SessionUser, month = dhakaMonth()): Promise<(PersonProgress & { daysLeft: number }) | null> {
  const board = await getTargetBoard(db, user, "own", month);
  const mine = board.people.find((p) => p.userId === user.id);
  return mine ? { ...mine, daysLeft: board.daysLeft } : null;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────

const SORT_KEY: Record<LeaderboardSort, (s: Stats) => number> = {
  value: (s) => s.salesPaisa,
  delivered: (s) => s.deliveredPaisa,
  orders: (s) => s.orderCount,
};

/**
 * Ranks the whole sales floor, then returns only the rows this user may
 * see. Ties on the chosen measure go to the better delivered rate, so
 * orders that came back never out-rank ones that stuck.
 */
export async function getLeaderboard(db: Db, user: SessionUser, level: ViewLevel, month: string, sort: LeaderboardSort): Promise<Leaderboard> {
  const everyone = await db.user.findMany({
    where: salesFloorWhere,
    select: { id: true, name: true, teamId: true, team: { select: { name: true } }, salesTargets: { where: { month }, select: { orderValue: true } } },
  });
  const byUser = await statsByUser(
    db,
    month,
    everyone.map((u) => u.id),
  );
  const key = SORT_KEY[sort];
  const rate = (s: Stats) => s.deliveredRate ?? -1;
  const ranked = everyone
    .map((u) => ({ u, s: statsOrEmpty(byUser, u.id) }))
    .sort((a, b) => key(b.s) - key(a.s) || rate(b.s) - rate(a.s) || a.u.name.localeCompare(b.u.name));

  const visible = (u: (typeof everyone)[number]) => level === "all" || u.id === user.id || (level === "team" && user.teamId !== null && u.teamId === user.teamId);
  const rows: LeaderboardRow[] = [];
  ranked.forEach(({ u, s }, i) => {
    if (!visible(u)) return;
    const valueTarget = u.salesTargets[0]?.orderValue;
    rows.push({
      rank: i + 1,
      userId: u.id,
      name: u.name,
      teamName: u.team?.name ?? null,
      stats: statsView(s),
      valueProgress: valueTarget ? progressRatio(s.salesPaisa, toPaisa(valueTarget)) : null,
      isMe: u.id === user.id,
    });
  });

  let teams: TeamLeaderboardRow[] = [];
  if (level !== "own") {
    const allTeams = await db.team.findMany({ where: { isActive: true }, select: { id: true, name: true, salesTargets: { where: { month }, select: { orderValue: true } } } });
    const byTeam = await statsByTeam(
      db,
      month,
      allTeams.map((t) => t.id),
    );
    teams = allTeams
      .map((t) => ({ t, s: statsOrEmpty(byTeam, t.id) }))
      .sort((a, b) => key(b.s) - key(a.s) || rate(b.s) - rate(a.s) || a.t.name.localeCompare(b.t.name))
      .map(({ t, s }, i) => ({
        rank: i + 1,
        teamId: t.id,
        name: t.name,
        stats: statsView(s),
        valueProgress: t.salesTargets[0]?.orderValue ? progressRatio(s.salesPaisa, toPaisa(t.salesTargets[0].orderValue)) : null,
      }))
      .filter((row) => level === "all" || row.teamId === user.teamId);
  }

  return { month, sort, ranked: ranked.length, rows, teams };
}

// ─── Setting targets (target.manage) ─────────────────────────────────────

/** Who can be given a target: the sales floor, and every active team. */
export async function listTargetSubjects(db: Db): Promise<{ people: TargetPerson[]; teams: TargetTeam[] }> {
  const [people, teams] = await Promise.all([
    db.user.findMany({ where: salesFloorWhere, select: { id: true, name: true, team: { select: { name: true } } }, orderBy: { name: "asc" } }),
    db.team.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { people: people.map((p) => ({ id: p.id, name: p.name, teamName: p.team?.name ?? null })), teams };
}

/** A month targets may still be set for: not worked out yet, and at most a year ahead. */
async function assertOpenMonth(db: Db, month: string) {
  if (!MONTH_PATTERN.test(month)) throw new TargetError("Pick a month.");
  if (month > shiftMonth(dhakaMonth(), 12)) throw new TargetError("Targets can be set up to a year ahead.");
  if (await isMonthLocked(db, month)) throw new TargetError("This month's rewards have been worked out, so its targets are final.", 409);
}

export type TargetInput = {
  month: string;
  userId?: string | null;
  teamId?: string | null;
  orderCount?: number | null;
  orderValue?: number | null;
  note?: string | null;
};

const auditShape = (t: TargetRow & { month: string; userId: string | null; teamId: string | null }) => ({
  month: t.month,
  userId: t.userId,
  teamId: t.teamId,
  orderCount: t.orderCount,
  orderValue: t.orderValue?.toString() ?? null,
  note: t.note,
});

export async function setTarget(db: Db, actor: SessionUser, input: TargetInput, ctx: AuditContext = {}) {
  await assertOpenMonth(db, input.month);
  if (Boolean(input.userId) === Boolean(input.teamId)) throw new TargetError("A target is for one person or one team.");
  if (!input.orderCount && !input.orderValue) throw new TargetError("Set an order count, an order value, or both.");
  if (input.userId) {
    const ok = await db.user.count({ where: { AND: [{ id: input.userId }, salesFloorWhere] } });
    if (!ok) throw new TargetError("Targets are for sales executives and team leaders.", 404);
  } else {
    const ok = await db.team.count({ where: { id: input.teamId!, isActive: true } });
    if (!ok) throw new TargetError("Team not found.", 404);
  }

  const data = { orderCount: input.orderCount || null, orderValue: input.orderValue ? String(input.orderValue) : null, note: input.note?.trim() || null };
  return withTx(db, async (tx) => {
    const where = input.userId ? { month: input.month, userId: input.userId } : { month: input.month, teamId: input.teamId! };
    const before = await tx.salesTarget.findFirst({ where });
    const saved = before
      ? await tx.salesTarget.update({ where: { id: before.id }, data })
      : await tx.salesTarget.create({ data: { ...where, ...data, createdById: actor.id } });
    await writeAuditLogWith(tx, {
      actorId: actor.id,
      action: before ? "target.update" : "target.create",
      entityType: "target",
      entityId: saved.id,
      before: before ? auditShape(before) : undefined,
      after: auditShape(saved),
      request: ctx.request,
    });
    return saved;
  });
}

export async function deleteTarget(db: Db, actor: SessionUser, id: string, ctx: AuditContext = {}) {
  const target = await db.salesTarget.findUnique({ where: { id } });
  if (!target) throw new TargetError("Target not found.", 404);
  await assertOpenMonth(db, target.month);
  await withTx(db, async (tx) => {
    await tx.salesTarget.delete({ where: { id } });
    await writeAuditLogWith(tx, { actorId: actor.id, action: "target.delete", entityType: "target", entityId: id, before: auditShape(target), request: ctx.request });
  });
}

/** Carries last month's targets into `month` for everyone who has none there yet. Returns how many were added. */
export async function copyTargets(db: Db, actor: SessionUser, month: string, ctx: AuditContext = {}): Promise<number> {
  await assertOpenMonth(db, month);
  const from = shiftMonth(month, -1);
  const [source, existing, eligibleUsers, activeTeams] = await Promise.all([
    db.salesTarget.findMany({ where: { month: from } }),
    db.salesTarget.findMany({ where: { month }, select: { userId: true, teamId: true } }),
    db.user.findMany({ where: salesFloorWhere, select: { id: true } }),
    db.team.findMany({ where: { isActive: true }, select: { id: true } }),
  ]);
  const taken = new Set(existing.map((t) => t.userId ?? t.teamId));
  const okUsers = new Set(eligibleUsers.map((u) => u.id));
  const okTeams = new Set(activeTeams.map((t) => t.id));
  const toCopy = source.filter((t) => !taken.has(t.userId ?? t.teamId) && (t.userId ? okUsers.has(t.userId) : okTeams.has(t.teamId!)));
  if (toCopy.length === 0) return 0;

  await withTx(db, async (tx) => {
    await tx.salesTarget.createMany({
      data: toCopy.map((t) => ({ month, userId: t.userId, teamId: t.teamId, orderCount: t.orderCount, orderValue: t.orderValue, note: t.note, createdById: actor.id })),
    });
    await writeAuditLogWith(tx, {
      actorId: actor.id,
      action: "target.copy",
      entityType: "target",
      entityId: month,
      after: { from, month, targets: toCopy.map((t) => auditShape({ ...t, month })) },
      request: ctx.request,
    });
  });
  return toCopy.length;
}
