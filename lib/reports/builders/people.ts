import "server-only";

import type { Prisma } from "@prisma/client";

import { getAttendanceSheet } from "@/lib/attendance/sheet";
import type { AttendanceTotals } from "@/lib/attendance/types";
import { toPaisa } from "@/lib/inventory/costing";
import { LEAD_LOST_REASON_LABELS } from "@/lib/leads/constants";
import { getLeadConversionReport } from "@/lib/leads/report";
import type { ConversionRow } from "@/lib/leads/types";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { peopleWhere } from "@/lib/reports/access";
import { figure, money, monthLabel, monthsIn, ratio, withQuery, type BuildContext, type BuiltReport } from "@/lib/reports/shared";
import type { ReportColumn, ReportRow } from "@/lib/reports/types";
import { NOT_A_SALE_STATUSES } from "@/lib/targets/constants";
import { statsFromBuckets, type StatusBucket } from "@/lib/targets/stats";

// R2 Leads, R3 Team performance, R10 Attendance (PRD §4.15).

// ---------------------------------------------------------------------------
// R2 Leads — the P4.1 conversion report, as a report
// ---------------------------------------------------------------------------

const CONVERSION_COLUMNS = (first: string): ReportColumn[] => [
  { key: "label", label: first },
  { key: "recorded", label: "Recorded", format: "int" },
  { key: "counted", label: "Counted", format: "int" },
  { key: "leads", label: "Leads", format: "int" },
  { key: "converted", label: "Converted", format: "int" },
  { key: "lost", label: "Lost", format: "int" },
  { key: "open", label: "Open", format: "int" },
  { key: "rate", label: "Conversion", format: "percent" },
  { key: "value", label: "Converted value", format: "money" },
];

const conversionRow = (r: ConversionRow): ReportRow => ({ label: r.label, recorded: r.recorded, counted: r.counted, leads: r.leads, converted: r.converted, lost: r.lost, open: r.open, rate: r.rate, value: r.convertedValue });

export async function buildLeadsReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const r = await getLeadConversionReport(ctx.db, ctx.user, { fromDay: f.fromDay, toDay: f.toDay, ownerId: f.personId, teamId: f.teamId, source: f.source });
  const lostTotal = r.lostReasons.reduce((a, x) => a + x.count, 0);
  return {
    figures: [
      figure("Leads", r.totals.leads, "int", { hint: `${r.totals.recorded} recorded · ${r.totals.counted} counted` }),
      figure("Converted", r.totals.converted, "int"),
      figure("Conversion", r.totals.rate, "percent"),
      figure("Lost", r.totals.lost, "int"),
      figure("Still open", r.totals.open, "int"),
      figure("Converted value", r.totals.convertedValue, "money"),
    ],
    tables: [
      { id: "by-source", title: "By source", columns: CONVERSION_COLUMNS("Source"), rows: r.bySource.map(conversionRow), totals: conversionRow({ ...r.totals, label: "Total" }), empty: "No leads in this period." },
      { id: "by-campaign", title: "By campaign", columns: CONVERSION_COLUMNS("Campaign"), rows: r.byCampaign.map(conversionRow), empty: "No leads in this period." },
      { id: "by-person", title: "By sales executive", columns: CONVERSION_COLUMNS("Executive"), rows: r.bySe.map(conversionRow), empty: "No leads in this period." },
      {
        id: "lost-reasons",
        title: "Lost reasons",
        columns: [
          { key: "reason", label: "Reason" },
          { key: "count", label: "Leads", format: "int" },
          { key: "share", label: "Share", format: "percent" },
        ],
        rows: r.lostReasons.map((x) => ({ reason: LEAD_LOST_REASON_LABELS[x.reason], count: x.count, share: ratio(x.count, lostTotal), _href: withQuery("/leads", { status: "LOST" }) })),
        empty: "No leads were lost in this period.",
      },
    ],
    notes: [
      "The leads that came in during the period (recorded ones by the day they were created, daily counts by the day counted) and how many have converted since. Open and lost exist only for recorded leads.",
      "Converted value is the total of the orders those leads became (cancelled orders left out).",
    ],
  };
}

// ---------------------------------------------------------------------------
// R3 Team performance
// ---------------------------------------------------------------------------

export async function buildTeamReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const db = ctx.db;
  const people = await db.user.findMany({
    where: { AND: [peopleWhere(ctx.user, "team", ctx.level), ...(f.personId ? [{ id: f.personId }] : []), ...(f.teamId ? [{ teamId: f.teamId }] : [])] },
    select: { id: true, name: true, team: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  const ids = people.map((p) => p.id);
  const range = { gte: f.from, lt: f.to };
  const months = monthsIn(f.fromDay, f.toDay);

  const [leads, converted, counts, orders, exchanges, targets] = await Promise.all([
    db.lead.groupBy({ by: ["createdById"], where: { createdById: { in: ids }, deletedAt: null, createdAt: range }, _count: { _all: true } }),
    db.lead.groupBy({ by: ["createdById"], where: { createdById: { in: ids }, deletedAt: null, createdAt: range, status: "CONVERTED" }, _count: { _all: true } }),
    db.leadDailyCount.groupBy({ by: ["userId"], where: { userId: { in: ids }, countDate: range }, _sum: { leadCount: true, convertedCount: true } }),
    // The targets rule (PRD §4.13): placed in the period, not LEAD/CANCELLED,
    // not an exchange's replacement; returned ones count under quality only.
    db.order.groupBy({
      by: ["createdById", "status"],
      where: { createdById: { in: ids }, deletedAt: null, exchangedFromOrderId: null, createdAt: range, status: { notIn: [...NOT_A_SALE_STATUSES] }, ...(f.channel ? { channel: f.channel } : {}) },
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.returnCase.findMany({
      where: { type: "EXCHANGE", status: { in: ["APPROVED", "COMPLETED"] }, decidedAt: range, order: { createdById: { in: ids }, deletedAt: null, ...(f.channel ? { channel: f.channel } : {}) } },
      select: { order: { select: { createdById: true } } },
    }),
    db.salesTarget.findMany({ where: { userId: { in: ids }, month: { in: months } }, select: { userId: true, orderCount: true, orderValue: true } }),
  ]);

  const leadCount = new Map(leads.map((l) => [l.createdById, l._count._all]));
  const convertedCount = new Map(converted.map((l) => [l.createdById, l._count._all]));
  const countMap = new Map(counts.map((c) => [c.userId, c._sum]));
  const buckets = new Map<string, StatusBucket[]>();
  for (const o of orders) {
    if (!o.createdById) continue;
    const list = buckets.get(o.createdById) ?? [];
    list.push({ status: o.status as OrderStatusValue, totalPaisa: toPaisa(o._sum.total ?? 0), count: o._count._all });
    buckets.set(o.createdById, list);
  }
  const exchanged = new Map<string, number>();
  for (const e of exchanges) if (e.order.createdById) exchanged.set(e.order.createdById, (exchanged.get(e.order.createdById) ?? 0) + 1);
  const target = new Map<string, { value: number; count: number; hasValue: boolean; hasCount: boolean }>();
  for (const t of targets) {
    if (!t.userId) continue;
    const x = target.get(t.userId) ?? { value: 0, count: 0, hasValue: false, hasCount: false };
    if (t.orderValue !== null) {
      x.value += toPaisa(t.orderValue);
      x.hasValue = true;
    }
    if (t.orderCount !== null) {
      x.count += t.orderCount;
      x.hasCount = true;
    }
    target.set(t.userId, x);
  }

  const tot = { leads: 0, converted: 0, orders: 0, value: 0, delivered: 0, returned: 0, exchanged: 0, targetValue: 0 };
  const rows: ReportRow[] = people.map((p) => {
    const s = statsFromBuckets(buckets.get(p.id) ?? []);
    const c = countMap.get(p.id);
    const nLeads = (leadCount.get(p.id) ?? 0) + (c?.leadCount ?? 0);
    const nConverted = (convertedCount.get(p.id) ?? 0) + (c?.convertedCount ?? 0);
    const t = target.get(p.id);
    const ex = exchanged.get(p.id) ?? 0;
    tot.leads += nLeads;
    tot.converted += nConverted;
    tot.orders += s.orderCount;
    tot.value += s.salesPaisa;
    tot.delivered += s.delivered;
    tot.returned += s.returned;
    tot.exchanged += ex;
    if (t?.hasValue) tot.targetValue += t.value;
    return {
      name: p.name,
      team: p.team?.name ?? "—",
      leads: nLeads,
      converted: nConverted,
      conversion: ratio(nConverted, nLeads),
      orders: s.orderCount,
      value: money(s.salesPaisa),
      delivered: s.delivered,
      returned: s.returned,
      deliveredRate: s.deliveredRate,
      exchanged: ex,
      targetValue: t?.hasValue ? money(t.value) : null,
      targetPct: t?.hasValue ? ratio(s.salesPaisa, t.value) : null,
      targetOrders: t?.hasCount ? t.count : null,
      targetCountPct: t?.hasCount ? ratio(s.orderCount, t.count) : null,
      _href: withQuery("/orders", { preset: "sales", createdById: p.id, from: f.fromDay, to: f.toDay, channel: f.channel }),
    };
  });
  rows.sort((a, b) => Number(b.value) - Number(a.value));

  return {
    figures: [
      figure("People", people.length, "int"),
      figure("Leads", tot.leads, "int"),
      figure("Conversion", ratio(tot.converted, tot.leads), "percent"),
      figure("Orders", tot.orders, "int"),
      figure("Order value", money(tot.value), "money"),
      figure("Delivered rate", ratio(tot.delivered, tot.delivered + tot.returned), "percent", { hint: `${tot.delivered} delivered · ${tot.returned} returned` }),
    ],
    tables: [
      {
        id: "per-person",
        title: "Per sales executive",
        columns: [
          { key: "name", label: "Executive" },
          { key: "team", label: "Team" },
          { key: "leads", label: "Leads", format: "int" },
          { key: "converted", label: "Converted", format: "int" },
          { key: "conversion", label: "Conversion", format: "percent" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "delivered", label: "Delivered", format: "int" },
          { key: "returned", label: "Returned", format: "int" },
          { key: "deliveredRate", label: "Delivered rate", format: "percent" },
          { key: "exchanged", label: "Exchanged", format: "int" },
          { key: "targetValue", label: "Value target", format: "money" },
          { key: "targetPct", label: "Target %", format: "percent" },
          { key: "targetOrders", label: "Order target", format: "int" },
          { key: "targetCountPct", label: "Orders %", format: "percent" },
        ],
        rows,
        totals: { name: "Total", leads: tot.leads, converted: tot.converted, conversion: ratio(tot.converted, tot.leads), orders: tot.orders, value: money(tot.value), delivered: tot.delivered, returned: tot.returned, deliveredRate: ratio(tot.delivered, tot.delivered + tot.returned), exchanged: tot.exchanged },
        empty: "No one to show for these filters.",
      },
    ],
    notes: [
      "Orders and value follow the targets rule: placed in the period, not cancelled, not an exchange's replacement. Fully returned orders count under Returned, not in the value.",
      "Delivered rate = delivered ÷ (delivered + returned) for the period's orders — so volume alone can't win. Exchanged = exchanges approved in the period on the person's orders.",
      months.length > 1 || f.fromDay.slice(8) !== "01"
        ? `Targets are monthly: the target shown adds up ${months.map(monthLabel).join(", ")}. A part-month range compares part of a month's sales with the whole month's target.`
        : "Targets are monthly; the period's value is compared with the month's target.",
    ],
  };
}

// ---------------------------------------------------------------------------
// R10 Attendance — the P4.2 sheet, month by month, cut to the range
// ---------------------------------------------------------------------------

const EMPTY_TOTALS = (): AttendanceTotals => ({ workingDays: 0, present: 0, late: 0, halfDay: 0, absent: 0, leave: 0, noCheckOut: 0, lateMinutes: 0, offDaysWorked: 0 });

export async function buildAttendanceReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  if (!ctx.level) return { figures: [], tables: [], notes: [] };
  const allowed = f.teamId ? new Set((await ctx.db.user.findMany({ where: { teamId: f.teamId } as Prisma.UserWhereInput, select: { id: true } })).map((u) => u.id)) : null;

  type Person = { name: string; role: string; team: string; totals: AttendanceTotals };
  const people = new Map<string, Person>();
  const byMonth: ReportRow[] = [];
  const grand = EMPTY_TOTALS();

  const level = ctx.level;
  const months = monthsIn(f.fromDay, f.toDay);
  const sheets = await Promise.all(months.map((month) => getAttendanceSheet(ctx.db, ctx.user, level, month, { userId: f.personId, now: ctx.now })));
  for (const [i, month] of months.entries()) {
    const sheet = sheets[i];
    const kinds = new Map(sheet.days.map((d) => [d.day, d.kind]));
    const monthTotals = EMPTY_TOTALS();
    for (const row of sheet.rows) {
      if (allowed && !allowed.has(row.userId)) continue;
      const p = people.get(row.userId) ?? { name: row.name, role: row.role, team: row.teamName ?? "—", totals: EMPTY_TOTALS() };
      people.set(row.userId, p);
      // The same counting as the P4.2 sheet (lib/attendance/days.ts), for the days in range.
      for (const d of row.days) {
        if (d.day < f.fromDay || d.day > f.toDay || d.day > sheet.today) continue;
        for (const t of [p.totals, monthTotals, grand]) {
          if (kinds.get(d.day) === "WORKING" && d.mark !== "NONE") t.workingDays += 1;
          if (d.record) {
            t.present += 1;
            if (d.record.lateMinutes > 0) t.late += 1;
            t.lateMinutes += d.record.lateMinutes;
            if (d.record.status === "HALF_DAY") t.halfDay += 1;
            if (d.workedOffDay) t.offDaysWorked += 1;
            if (d.noCheckOut) t.noCheckOut += 1;
          }
          if (d.mark === "ABSENT") t.absent += 1;
          if (d.mark === "LEAVE") t.leave += 1;
        }
      }
    }
    byMonth.push({ month: monthLabel(month), ...totalsRow(monthTotals), _href: withQuery("/attendance/report", { month }) });
  }

  const cols: ReportColumn[] = [
    { key: "workingDays", label: "Working days", format: "int" },
    { key: "present", label: "Present", format: "int" },
    { key: "late", label: "Late", format: "int" },
    { key: "halfDay", label: "Half day", format: "int" },
    { key: "absent", label: "Absent", format: "int" },
    { key: "leave", label: "Leave", format: "int" },
    { key: "noCheckOut", label: "No check-out", format: "int" },
    { key: "lateMinutes", label: "Late minutes", format: "int" },
    { key: "attendance", label: "Attendance", format: "percent" },
  ];

  return {
    figures: [
      figure("Staff", people.size, "int"),
      figure("Present days", grand.present, "int"),
      figure("Late", grand.late, "int"),
      figure("Absent", grand.absent, "int"),
      figure("Leave", grand.leave, "int"),
      figure("Attendance", ratio(grand.present - grand.offDaysWorked, grand.workingDays), "percent", { hint: "present ÷ working days" }),
    ],
    tables: [
      {
        id: "per-person",
        title: "Per staff member",
        columns: [{ key: "name", label: "Staff" }, { key: "role", label: "Role" }, { key: "team", label: "Team" }, ...cols],
        rows: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ name: p.name, role: p.role, team: p.team, ...totalsRow(p.totals) })),
        totals: { name: "Total", ...totalsRow(grand) },
        empty: "No one to show for these filters.",
      },
      { id: "by-month", title: "Month by month", columns: [{ key: "month", label: "Month" }, ...cols], rows: byMonth },
    ],
    notes: [
      "Days so far only, counted the same way as the monthly attendance sheet: a working day with no check-in is Absent unless approved leave covers it; weekly offs and holidays don't count as working days.",
      "Attendance = days present on working days ÷ working days.",
    ],
  };
}

function totalsRow(t: AttendanceTotals): ReportRow {
  return { workingDays: t.workingDays, present: t.present, late: t.late, halfDay: t.halfDay, absent: t.absent, leave: t.leave, noCheckOut: t.noCheckOut, lateMinutes: t.lateMinutes, attendance: ratio(t.present - t.offDaysWorked, t.workingDays) };
}
