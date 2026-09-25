import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { isOpenLeadStatus, LEAD_LOST_REASON_VALUES, LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES, type LeadLostReasonValue, type LeadSourceValue, type LeadStatusValue } from "@/lib/leads/constants";
import type { ConversionRow, LeadConversionReport } from "@/lib/leads/types";

// PRD §4.5 conversion-rate reporting, per executive, source and campaign.
//
// A cohort report: the leads that came in during the period (recorded ones
// by the day they were created, counted ones by the day they were counted)
// and how many of them have converted since. Recorded and counted leads add
// together; open and lost exist only for recorded leads, since a count
// carries just "how many" and "how many bought".
//
// Scoped like every lead list (CLAUDE.md rule 6): an executive's report is
// their own leads, a team leader's their team's. Nothing here is cost or
// profit — the converted value is the order total the executive already
// sees on their own orders.

type Bucket = { label: string; recorded: number; counted: number; converted: number; lost: number; open: number; valuePaisa: number };

const NO_CAMPAIGN = "__none__";
const UNASSIGNED = "__unassigned__";

function emptyBucket(label: string): Bucket {
  return { label, recorded: 0, counted: 0, converted: 0, lost: 0, open: 0, valuePaisa: 0 };
}

function toRow(key: string, b: Bucket): ConversionRow {
  const leads = b.recorded + b.counted;
  return {
    key,
    label: b.label,
    recorded: b.recorded,
    counted: b.counted,
    leads,
    converted: b.converted,
    lost: b.lost,
    open: b.open,
    rate: leads > 0 ? b.converted / leads : null,
    convertedValue: fromPaisa(b.valuePaisa),
  };
}

const byLeadsThenLabel = (a: ConversionRow, b: ConversionRow) => b.leads - a.leads || a.label.localeCompare(b.label);

export type ConversionReportFilters = { fromDay: string; toDay: string; ownerId?: string; source?: LeadSourceValue };

export async function getLeadConversionReport(db: Db, user: SessionUser, filters: ConversionReportFilters): Promise<LeadConversionReport> {
  const from = dhakaDayStartUtc(filters.fromDay);
  const to = dhakaDayStartUtc(filters.toDay, 1);

  const leadWhere = scopedWhere(
    {
      deletedAt: null,
      createdAt: { gte: from, lt: to },
      ...(filters.ownerId ? { createdById: filters.ownerId } : {}),
      ...(filters.source ? { source: filters.source } : {}),
    },
    user,
  ) as Prisma.LeadWhereInput;
  const countWhere = scopedWhere(
    {
      countDate: { gte: from, lt: to },
      ...(filters.ownerId ? { userId: filters.ownerId } : {}),
      ...(filters.source ? { source: filters.source } : {}),
    },
    user,
    { ownerField: "userId" },
  ) as Prisma.LeadDailyCountWhereInput;

  const [leads, counts] = await Promise.all([
    db.lead.findMany({
      where: leadWhere,
      select: {
        status: true,
        source: true,
        campaign: true,
        lostReason: true,
        createdBy: { select: { id: true, name: true } },
        order: { select: { total: true, status: true, deletedAt: true } },
      },
    }),
    db.leadDailyCount.findMany({
      where: countWhere,
      select: { source: true, campaign: true, leadCount: true, convertedCount: true, user: { select: { id: true, name: true } } },
    }),
  ]);

  const total = emptyBucket("All leads");
  const bySe = new Map<string, Bucket>();
  const bySource = new Map<string, Bucket>();
  const byCampaign = new Map<string, Bucket>();
  const lost = new Map<LeadLostReasonValue, number>();

  function buckets(owner: { id: string; name: string } | null, source: LeadSourceValue, campaign: string | null): Bucket[] {
    const seKey = owner?.id ?? UNASSIGNED;
    const campaignName = campaign?.trim() || null;
    const campaignKey = campaignName?.toLowerCase() ?? NO_CAMPAIGN;
    if (!bySe.has(seKey)) bySe.set(seKey, emptyBucket(owner?.name ?? "Unassigned"));
    if (!bySource.has(source)) bySource.set(source, emptyBucket(LEAD_SOURCE_LABELS[source]));
    // The first spelling seen names the campaign; case and spacing don't split it.
    if (!byCampaign.has(campaignKey)) byCampaign.set(campaignKey, emptyBucket(campaignName ?? "No campaign"));
    return [total, bySe.get(seKey)!, bySource.get(source)!, byCampaign.get(campaignKey)!];
  }

  for (const lead of leads) {
    const status: LeadStatusValue = lead.status;
    const orderCounts = lead.order && !lead.order.deletedAt && lead.order.status !== "CANCELLED";
    for (const b of buckets(lead.createdBy, lead.source, lead.campaign)) {
      b.recorded += 1;
      if (status === "CONVERTED") b.converted += 1;
      else if (status === "LOST") b.lost += 1;
      else if (isOpenLeadStatus(status)) b.open += 1;
      if (orderCounts) b.valuePaisa += toPaisa(lead.order!.total);
    }
    if (status === "LOST" && lead.lostReason) lost.set(lead.lostReason, (lost.get(lead.lostReason) ?? 0) + 1);
  }

  for (const c of counts) {
    for (const b of buckets(c.user, c.source, c.campaign)) {
      b.counted += c.leadCount;
      b.converted += c.convertedCount;
    }
  }

  const sourceRows = [...bySource.entries()].map(([k, b]) => toRow(k, b));
  sourceRows.sort((a, b) => LEAD_SOURCE_VALUES.indexOf(a.key as LeadSourceValue) - LEAD_SOURCE_VALUES.indexOf(b.key as LeadSourceValue));

  return {
    fromDay: filters.fromDay,
    toDay: filters.toDay,
    totals: toRow("total", total),
    bySe: [...bySe.entries()].map(([k, b]) => toRow(k, b)).sort(byLeadsThenLabel),
    bySource: sourceRows,
    // "No campaign" last: it's the remainder, not a campaign.
    byCampaign: [...byCampaign.entries()]
      .map(([k, b]) => toRow(k, b))
      .sort((a, b) => Number(a.key === NO_CAMPAIGN) - Number(b.key === NO_CAMPAIGN) || byLeadsThenLabel(a, b)),
    lostReasons: LEAD_LOST_REASON_VALUES.map((reason) => ({ reason, count: lost.get(reason) ?? 0 })).filter((r) => r.count > 0),
  };
}

/** The report as CSV: one section per breakdown, same numbers as the screen. */
export function conversionReportCsv(report: LeadConversionReport): string {
  const header = ["Breakdown", "Name", "Recorded leads", "Counted leads", "Total leads", "Converted", "Lost", "Open", "Conversion %", "Converted order value (BDT)"];
  const line = (section: string, r: ConversionRow) => [section, r.label, r.recorded, r.counted, r.leads, r.converted, r.lost, r.open, r.rate === null ? "" : (r.rate * 100).toFixed(1), r.convertedValue];
  const rows = [
    line("Total", report.totals),
    ...report.bySe.map((r) => line("Sales executive", r)),
    ...report.bySource.map((r) => line("Source", r)),
    ...report.byCampaign.map((r) => line("Campaign", r)),
  ];
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(escape).join(",")).join("\n") + "\n";
}
