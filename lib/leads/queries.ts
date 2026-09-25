import "server-only";

import type { Prisma } from "@prisma/client";

import { loadEffectivePermissions } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { LEAD_STATUS_VALUES, OPEN_LEAD_STATUSES, type LeadFollowUpFilter, type LeadSourceValue, type LeadStatusValue } from "@/lib/leads/constants";
import { dhakaDayStartOf } from "@/lib/leads/dates";
import { LEAD_DETAIL_INCLUDE, LEAD_LIST_INCLUDE, serializeLeadDetail, serializeLeadListItem } from "@/lib/leads/serialize";
import type { DueFollowUp, LeadDetail, LeadListItem, LeadPerson, LeadStatusCounts } from "@/lib/leads/types";

// Scoped reads for the leads screens. The scope clause is always AND-ed in
// last (lib/auth/scope.ts), so no filter a client sends can widen it.

export type LeadListFilters = {
  q?: string;
  /** "open" = every stage still being worked. */
  status?: LeadStatusValue | "open";
  source?: LeadSourceValue;
  ownerId?: string;
  followUp?: LeadFollowUpFilter;
  campaign?: string;
};

const OPEN_FOLLOW_UP = { completedAt: null } satisfies Prisma.LeadFollowUpWhereInput;

function followUpWhere(filter: LeadFollowUpFilter, now: Date): Prisma.LeadWhereInput {
  const endOfToday = dhakaDayStartOf(now, 1);
  const open: Prisma.LeadWhereInput = { status: { in: [...OPEN_LEAD_STATUSES] } };
  switch (filter) {
    case "overdue":
      return { ...open, followUps: { some: { ...OPEN_FOLLOW_UP, dueAt: { lt: now } } } };
    case "today":
      return { ...open, followUps: { some: { ...OPEN_FOLLOW_UP, dueAt: { gte: now, lt: endOfToday } } } };
    case "upcoming":
      return { ...open, followUps: { some: { ...OPEN_FOLLOW_UP, dueAt: { gte: endOfToday } } } };
    case "none":
      return { ...open, followUps: { none: OPEN_FOLLOW_UP } };
  }
}

/** Every filter except status — the status chips count within these. */
function baseConditions(filters: LeadListFilters, now: Date): Prisma.LeadWhereInput[] {
  const and: Prisma.LeadWhereInput[] = [{ deletedAt: null }];
  if (filters.source) and.push({ source: filters.source });
  // Safe to take from the client: scope is AND-ed in after (rule 6).
  if (filters.ownerId) and.push({ createdById: filters.ownerId });
  if (filters.campaign) and.push({ campaign: { equals: filters.campaign, mode: "insensitive" } });
  if (filters.followUp) and.push(followUpWhere(filters.followUp, now));
  const q = filters.q?.trim();
  if (q) {
    const digits = q.replace(/[\s-]/g, "");
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { campaign: { contains: q, mode: "insensitive" } },
        { interest: { contains: q, mode: "insensitive" } },
        ...(/^\+?\d{3,}$/.test(digits) ? [{ phone: { contains: digits.replace(/^\+?88/, "") } }] : []),
      ],
    });
  }
  return and;
}

function statusWhere(status: LeadListFilters["status"]): Prisma.LeadWhereInput {
  if (!status) return {};
  return status === "open" ? { status: { in: [...OPEN_LEAD_STATUSES] } } : { status };
}

export async function listLeads(
  db: Db,
  user: SessionUser,
  filters: LeadListFilters,
  page: { page: number; pageSize: number },
): Promise<{ items: LeadListItem[]; total: number; counts: LeadStatusCounts }> {
  const now = new Date();
  const base = baseConditions(filters, now);
  const where = scopedWhere({ AND: [...base, statusWhere(filters.status)] }, user) as Prisma.LeadWhereInput;

  const [total, rows, grouped] = await Promise.all([
    db.lead.count({ where }),
    db.lead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
      include: LEAD_LIST_INCLUDE,
    }),
    db.lead.groupBy({ by: ["status"], where: scopedWhere({ AND: base }, user) as Prisma.LeadWhereInput, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(LEAD_STATUS_VALUES.map((s) => [s, 0])) as LeadStatusCounts;
  for (const g of grouped) counts[g.status] = g._count._all;

  return { items: rows.map(serializeLeadListItem), total, counts };
}

export async function loadLeadDetail(db: Db, user: SessionUser, id: string): Promise<LeadDetail | null> {
  const row = await db.lead.findFirst({ where: scopedWhere({ id, deletedAt: null }, user), include: LEAD_DETAIL_INCLUDE });
  return row ? serializeLeadDetail(row) : null;
}

/**
 * Open follow-ups due by the end of today (Dhaka), overdue first — the
 * "my follow-ups due today" list (PRD §4.5, §4.16). `days` reaches further
 * ahead for the follow-ups screen. Only on leads still being worked: a
 * converted or lost lead's reminders drop off.
 */
export async function listDueFollowUps(
  db: Db,
  user: SessionUser,
  opts: { limit?: number; now?: Date; days?: number } = {},
): Promise<{ items: DueFollowUp[]; overdue: number; dueToday: number; upcoming: number }> {
  const now = opts.now ?? new Date();
  const endOfToday = dhakaDayStartOf(now, 1);
  const until = dhakaDayStartOf(now, 1 + (opts.days ?? 0));
  const leadWhere = scopedWhere({ deletedAt: null, status: { in: [...OPEN_LEAD_STATUSES] } }, user) as Prisma.LeadWhereInput;
  const open = (dueAt: Prisma.DateTimeFilter): Prisma.LeadFollowUpWhereInput => ({ completedAt: null, dueAt, lead: leadWhere });

  const [rows, overdue, dueToday, upcoming] = await Promise.all([
    db.leadFollowUp.findMany({
      where: open({ lt: until }),
      orderBy: { dueAt: "asc" },
      take: opts.limit ?? 50,
      include: {
        lead: { select: { id: true, name: true, phone: true, status: true, source: true, interest: true, createdBy: { select: { id: true, name: true } } } },
      },
    }),
    db.leadFollowUp.count({ where: open({ lt: now }) }),
    db.leadFollowUp.count({ where: open({ gte: now, lt: endOfToday }) }),
    until > endOfToday ? db.leadFollowUp.count({ where: open({ gte: endOfToday, lt: until }) }) : Promise.resolve(0),
  ]);

  return {
    items: rows.map((f) => ({
      id: f.id,
      dueAt: f.dueAt.toISOString(),
      note: f.note,
      lead: { id: f.lead.id, name: f.lead.name, phone: f.lead.phone, status: f.lead.status, source: f.lead.source, interest: f.lead.interest },
      owner: f.lead.createdBy,
    })),
    overdue,
    dueToday,
    upcoming,
  };
}

/** Campaign names already in use within this user's scope, for the campaign field's suggestions. */
export async function listCampaignSuggestions(db: Db, user: SessionUser): Promise<string[]> {
  const since = new Date(Date.now() - 180 * 86_400_000);
  const [leads, counts] = await Promise.all([
    db.lead.findMany({ where: scopedWhere({ campaign: { not: null }, createdAt: { gte: since } }, user), select: { campaign: true }, distinct: ["campaign"], take: 200 }),
    db.leadDailyCount.findMany({ where: scopedWhere({ campaign: { not: null }, countDate: { gte: since } }, user, { ownerField: "userId" }), select: { campaign: true }, distinct: ["campaign"], take: 200 }),
  ]);
  const byKey = new Map<string, string>();
  for (const c of [...leads, ...counts]) if (c.campaign) byKey.set(c.campaign.toLowerCase(), byKey.get(c.campaign.toLowerCase()) ?? c.campaign);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Staff whose leads this user can see and record counts for: themself for
 * an executive, their team for a team leader, everyone who works leads for
 * a manager or the owner. The same scope helper, applied to the user table.
 */
export async function listLeadPeople(db: Db, user: SessionUser): Promise<LeadPerson[]> {
  const candidates = await db.user.findMany({
    where: scopedWhere({ isActive: true }, user, { ownerField: "id" }),
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const people: LeadPerson[] = [];
  for (const c of candidates) {
    const perms = await loadEffectivePermissions(db, c.id);
    if (perms.has("lead.create")) people.push(c);
  }
  return people;
}

/** Whether `targetUserId` is someone this user may record lead counts for. */
export async function canActForLeadPerson(db: Db, user: SessionUser, targetUserId: string): Promise<{ id: string; teamId: string | null } | null> {
  const target = await db.user.findFirst({ where: scopedWhere({ id: targetUserId, isActive: true }, user, { ownerField: "id" }), select: { id: true, teamId: true } });
  if (!target) return null;
  const perms = await loadEffectivePermissions(db, target.id);
  return perms.has("lead.create") ? target : null;
}
