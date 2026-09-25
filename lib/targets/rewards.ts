import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { salesFloorWhere } from "@/lib/auth/rosters";
import type { ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import type { RewardMetricValue, RewardScopeValue } from "@/lib/targets/constants";
import { dhakaMonth, MONTH_PATTERN, shiftMonth } from "@/lib/targets/month";
import { statsByTeam, statsByUser, statsOrEmpty } from "@/lib/targets/performance";
import { evaluateRewards, type SubjectInput } from "@/lib/targets/reward-rules";
import { TargetError } from "@/lib/targets/service";
import type { AwardView, MonthAwards, RewardRuleView } from "@/lib/targets/types";

// PRD §4.13 reward rules and their month-end evaluation. The month-end
// cron (app/api/cron/rewards) works out last month once; a Manager/Admin
// can re-run a closed month by hand, which replaces its awards. Either way
// the awards copy the rule in, so a rule edited later never changes what
// a past month earned. Rule changes and evaluations are audit-logged.

type AuditContext = { request?: Request };

type RuleRow = Prisma.RewardRuleGetPayload<object>;

export function ruleView(r: RuleRow): RewardRuleView {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    metric: r.metric,
    threshold: r.threshold.toString(),
    minDeliveredRate: r.minDeliveredRate,
    rewardAmount: r.rewardAmount ? fromPaisa(toPaisa(r.rewardAmount)) : null,
    rewardNote: r.rewardNote,
    isActive: r.isActive,
  };
}

const ruleAudit = (r: RuleRow) => ({ ...ruleView(r), id: undefined });

export async function listRules(db: Db, opts: { includeInactive?: boolean } = {}): Promise<RewardRuleView[]> {
  const rows = await db.rewardRule.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: "desc" }, { scope: "asc" }, { metric: "asc" }, { threshold: "asc" }],
  });
  return rows.map(ruleView);
}

export type RuleInput = {
  name: string;
  scope: RewardScopeValue;
  metric: RewardMetricValue;
  threshold: number;
  minDeliveredRate?: number | null;
  rewardAmount?: number | null;
  rewardNote?: string | null;
  isActive?: boolean;
};

function ruleData(input: RuleInput) {
  const note = input.rewardNote?.trim() || null;
  if (!input.rewardAmount && !note) throw new TargetError("Give the reward an amount, a note, or both.");
  return {
    name: input.name.trim(),
    scope: input.scope,
    metric: input.metric,
    threshold: String(input.threshold),
    minDeliveredRate: input.minDeliveredRate || null,
    rewardAmount: input.rewardAmount ? String(input.rewardAmount) : null,
    rewardNote: note,
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  };
}

export async function createRule(db: Db, actor: SessionUser, input: RuleInput, ctx: AuditContext = {}) {
  const data = ruleData(input);
  return withTx(db, async (tx) => {
    const rule = await tx.rewardRule.create({ data: { ...data, createdById: actor.id } });
    await writeAuditLogWith(tx, { actorId: actor.id, action: "reward_rule.create", entityType: "reward_rule", entityId: rule.id, after: ruleAudit(rule), request: ctx.request });
    return rule;
  });
}

export async function updateRule(db: Db, actor: SessionUser, id: string, input: RuleInput, ctx: AuditContext = {}) {
  const data = ruleData(input);
  return withTx(db, async (tx) => {
    const before = await tx.rewardRule.findUnique({ where: { id } });
    if (!before) throw new TargetError("Rule not found.", 404);
    const rule = await tx.rewardRule.update({ where: { id }, data });
    await writeAuditLogWith(tx, { actorId: actor.id, action: "reward_rule.update", entityType: "reward_rule", entityId: id, before: ruleAudit(before), after: ruleAudit(rule), request: ctx.request });
    return rule;
  });
}

// ─── Evaluation ──────────────────────────────────────────────────────────

type Computed = {
  awards: Omit<Prisma.RewardAwardCreateManyInput, "month">[];
  names: Map<string, string>;
};

/** Works the month out against today's data and the active rules, without saving anything. */
async function computeAwards(db: Db, month: string): Promise<Computed> {
  const rules = await db.rewardRule.findMany({ where: { isActive: true } });
  if (rules.length === 0) return { awards: [], names: new Map() };

  const [people, teams, targets] = await Promise.all([
    db.user.findMany({ where: { OR: [salesFloorWhere, { salesTargets: { some: { month } } }] }, select: { id: true, name: true } }),
    db.team.findMany({ where: { OR: [{ isActive: true }, { salesTargets: { some: { month } } }] }, select: { id: true, name: true } }),
    db.salesTarget.findMany({ where: { month } }),
  ]);
  const [byUser, byTeam] = await Promise.all([
    statsByUser(
      db,
      month,
      people.map((p) => p.id),
    ),
    statsByTeam(
      db,
      month,
      teams.map((t) => t.id),
    ),
  ]);
  const targetOf = (key: string) => {
    const t = targets.find((x) => x.userId === key || x.teamId === key);
    return t ? { orderCount: t.orderCount, orderValuePaisa: t.orderValue ? toPaisa(t.orderValue) : null } : null;
  };
  const subjects: SubjectInput[] = [
    ...people.map((p) => ({ scope: "INDIVIDUAL" as const, id: p.id, target: targetOf(p.id), stats: statsOrEmpty(byUser, p.id) })),
    ...teams.map((t) => ({ scope: "TEAM" as const, id: t.id, target: targetOf(t.id), stats: statsOrEmpty(byTeam, t.id) })),
  ];
  const statsOf = new Map(subjects.map((s) => [s.id, s.stats]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const earned = evaluateRewards(
    rules.map((r) => ({ id: r.id, name: r.name, scope: r.scope, metric: r.metric, threshold: Number(r.threshold.toString()), minDeliveredRate: r.minDeliveredRate })),
    subjects,
  );

  const awards = earned.map((e) => {
    const rule = ruleById.get(e.ruleId)!;
    const s = statsOf.get(e.subjectId)!;
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      scope: rule.scope,
      metric: rule.metric,
      threshold: rule.threshold,
      userId: e.scope === "INDIVIDUAL" ? e.subjectId : null,
      teamId: e.scope === "TEAM" ? e.subjectId : null,
      achieved: e.achieved.toFixed(2),
      salesValue: fromPaisa(s.salesPaisa),
      orderCount: s.orderCount,
      deliveredRate: s.deliveredRate === null ? null : (s.deliveredRate * 100).toFixed(2),
      rewardAmount: rule.rewardAmount,
      rewardNote: rule.rewardNote,
    };
  });
  const names = new Map([...people.map((p) => [p.id, p.name] as const), ...teams.map((t) => [t.id, t.name] as const)]);
  return { awards, names };
}

/**
 * Works out a closed month and saves its awards, replacing any earlier run.
 * `actor` null = the month-end cron.
 */
export async function evaluateMonth(db: Db, actor: SessionUser | null, month: string, ctx: AuditContext = {}) {
  if (!MONTH_PATTERN.test(month)) throw new TargetError("Pick a month.");
  if (month >= dhakaMonth()) throw new TargetError("Rewards are worked out once the month is over.", 409);
  const { awards } = await computeAwards(db, month);

  return withTx(db, async (tx) => {
    const before = await tx.rewardAward.findMany({ where: { month }, select: { ruleName: true, userId: true, teamId: true, rewardAmount: true } });
    await tx.rewardEvaluation.deleteMany({ where: { month } });
    await tx.rewardEvaluation.create({ data: { month, evaluatedById: actor?.id ?? null } });
    if (awards.length) await tx.rewardAward.createMany({ data: awards.map((a) => ({ ...a, month })) });
    const summary = (list: { ruleName: string; userId?: string | null; teamId?: string | null; rewardAmount?: unknown }[]) =>
      list.map((a) => ({ rule: a.ruleName, userId: a.userId ?? null, teamId: a.teamId ?? null, amount: a.rewardAmount ? String(a.rewardAmount) : null }));
    await writeAuditLogWith(tx, {
      actorId: actor?.id ?? null,
      action: "reward.evaluate",
      entityType: "reward_evaluation",
      entityId: month,
      before: before.length ? { awards: summary(before) } : undefined,
      after: { awards: summary(awards) },
      request: ctx.request,
    });
    return awards.length;
  });
}

/** The month-end job: works out last month once. Returns what it did. */
export async function evaluateLastMonthIfDue(db: Db): Promise<{ month: string; evaluated: boolean; awards?: number }> {
  const month = shiftMonth(dhakaMonth(), -1);
  if (await db.rewardEvaluation.count({ where: { month } })) return { month, evaluated: false };
  const awards = await evaluateMonth(db, null, month);
  return { month, evaluated: true, awards };
}

/**
 * A month's awards, cut to what this user may see: an executive their own,
 * a team leader their team's people and team, Admin/Manager everyone. A
 * month not worked out yet comes back as a preview — "if it ended today".
 */
export async function getMonthAwards(db: Db, user: SessionUser, level: ViewLevel, month: string): Promise<MonthAwards> {
  const evaluation = await db.rewardEvaluation.findUnique({ where: { month }, include: { evaluatedBy: { select: { name: true } } } });

  let rows: (Omit<Prisma.RewardAwardCreateManyInput, "month"> & { id?: string })[];
  let names: Map<string, string>;
  if (evaluation) {
    const saved = await db.rewardAward.findMany({ where: { month }, include: { user: { select: { name: true } }, team: { select: { name: true } } } });
    rows = saved;
    names = new Map(saved.map((a) => [a.userId ?? a.teamId!, a.user?.name ?? a.team?.name ?? ""]));
  } else {
    ({ awards: rows, names } = await computeAwards(db, month));
  }

  let teamMemberIds = new Set<string>();
  if (level === "team" && user.teamId) {
    const members = await db.user.findMany({ where: { teamId: user.teamId }, select: { id: true } });
    teamMemberIds = new Set(members.map((m) => m.id));
  }
  const visible = (a: { userId?: string | null; teamId?: string | null }) =>
    level === "all" || a.userId === user.id || (level === "team" && ((a.userId && teamMemberIds.has(a.userId)) || (a.teamId && a.teamId === user.teamId)));

  const awards: AwardView[] = rows.filter(visible).map((a) => {
    const subjectId = (a.userId ?? a.teamId)!;
    return {
      id: a.id ?? null,
      ruleId: a.ruleId ?? null,
      ruleName: a.ruleName,
      scope: a.scope,
      metric: a.metric,
      threshold: String(a.threshold),
      subjectName: names.get(subjectId) ?? "",
      userId: a.userId ?? null,
      teamId: a.teamId ?? null,
      achieved: String(a.achieved),
      salesValue: String(a.salesValue),
      orderCount: a.orderCount,
      deliveredRate: a.deliveredRate === null || a.deliveredRate === undefined ? null : Number(String(a.deliveredRate)) / 100,
      rewardAmount: a.rewardAmount ? fromPaisa(toPaisa(String(a.rewardAmount))) : null,
      rewardNote: a.rewardNote ?? null,
    };
  });
  awards.sort((x, y) => x.subjectName.localeCompare(y.subjectName) || x.ruleName.localeCompare(y.ruleName));

  return {
    month,
    evaluatedAt: evaluation?.evaluatedAt.toISOString() ?? null,
    evaluatedBy: evaluation ? (evaluation.evaluatedBy?.name ?? "Month-end run") : null,
    preview: !evaluation,
    awards,
  };
}
