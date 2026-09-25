import type { Prisma } from "@prisma/client";

import type { LeadDetail, LeadFollowUpView, LeadListItem } from "@/lib/leads/types";

const PERSON = { select: { id: true, name: true } } as const;

export const LEAD_LIST_INCLUDE = {
  createdBy: PERSON,
  customer: PERSON,
  order: { select: { id: true, orderNo: true } },
  followUps: { where: { completedAt: null }, orderBy: { dueAt: "asc" }, take: 1, select: { dueAt: true } },
  _count: { select: { followUps: { where: { completedAt: null } } } },
} satisfies Prisma.LeadInclude;

export const LEAD_DETAIL_INCLUDE = {
  createdBy: PERSON,
  customer: PERSON,
  order: { select: { id: true, orderNo: true } },
  followUps: { orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { dueAt: "asc" }], include: { createdBy: PERSON, completedBy: PERSON } },
} satisfies Prisma.LeadInclude;

type LeadListRow = Prisma.LeadGetPayload<{ include: typeof LEAD_LIST_INCLUDE }>;
type LeadDetailRow = Prisma.LeadGetPayload<{ include: typeof LEAD_DETAIL_INCLUDE }>;

type LeadBase = Omit<LeadListRow, "followUps" | "_count">;

function serializeBase(row: LeadBase, nextFollowUpAt: Date | null, openFollowUps: number): LeadListItem {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    source: row.source,
    campaign: row.campaign,
    interest: row.interest,
    status: row.status,
    lostReason: row.lostReason,
    nextFollowUpAt: nextFollowUpAt?.toISOString() ?? null,
    openFollowUps,
    owner: row.createdBy,
    customer: row.customer,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeLeadListItem(row: LeadListRow): LeadListItem {
  return serializeBase(row, row.followUps[0]?.dueAt ?? null, row._count.followUps);
}

export function serializeLeadDetail(row: LeadDetailRow): LeadDetail {
  const open = row.followUps.filter((f) => !f.completedAt);
  const followUps: LeadFollowUpView[] = row.followUps.map((f) => ({
    id: f.id,
    dueAt: f.dueAt.toISOString(),
    note: f.note,
    completedAt: f.completedAt?.toISOString() ?? null,
    outcome: f.outcome,
    createdBy: f.createdBy,
    completedBy: f.completedBy,
  }));
  return {
    ...serializeBase(row, open[0]?.dueAt ?? null, open.length),
    notes: row.notes,
    lostNote: row.lostNote,
    lostAt: row.lostAt?.toISOString() ?? null,
    convertedAt: row.convertedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    followUps,
  };
}

/** The fields an audit row records for a lead. */
export function leadAuditShape(row: {
  name: string;
  phone: string | null;
  source: string;
  campaign: string | null;
  interest: string | null;
  notes: string | null;
  status: string;
  lostReason: string | null;
  lostNote: string | null;
  customerId: string | null;
  createdById: string | null;
  deletedAt: Date | null;
}) {
  return {
    name: row.name,
    phone: row.phone,
    source: row.source,
    campaign: row.campaign,
    interest: row.interest,
    notes: row.notes,
    status: row.status,
    lostReason: row.lostReason,
    lostNote: row.lostNote,
    customerId: row.customerId,
    createdById: row.createdById,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
