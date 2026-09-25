import "server-only";

import type { Prisma } from "@prisma/client";

import { attendanceRosterWhere } from "@/lib/auth/rosters";
import { levelScopeWhere, type ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { DAY_MARK_CODES, DAY_MARK_LABELS, LEAVE_TYPE_LABELS, type LeaveStatusValue } from "@/lib/attendance/constants";
import { daySpan, leaveWorkingDays, markDays } from "@/lib/attendance/days";
import { dayKind, isDayOver } from "@/lib/attendance/rules";
import { getOfficeHours } from "@/lib/attendance/settings";
import type { AttendancePerson, AttendanceRecordView, AttendanceSheet, LeaveRequestView, TodayBoard, TodayBoardRow } from "@/lib/attendance/types";
import type { Db } from "@/lib/db/tx";
import { dhakaDayOf, dhakaDayStart, dhakaToday, monthDays, monthRange } from "@/lib/targets/month";

// PRD §4.14 — the monthly attendance sheet and report, today's board, and
// leave lists. Scoped by attendance.view_all / _team / _own (the caller
// passes the level from lib/auth/permissions.ts viewLevel): staff see
// their own, a team leader their team, Admin/Manager everyone.

type RecordRow = Prisma.AttendanceGetPayload<object>;

export function recordView(r: RecordRow): AttendanceRecordView {
  return {
    id: r.id,
    day: dhakaDayOf(r.workDate),
    checkInAt: r.checkInAt.toISOString(),
    checkOutAt: r.checkOutAt?.toISOString() ?? null,
    status: r.status,
    lateMinutes: r.lateMinutes,
    corrected: r.correctedAt !== null,
    correctionReason: r.correctionReason,
  };
}

function rosterWhere(user: SessionUser, level: ViewLevel, userId?: string): Prisma.UserWhereInput {
  return { AND: [attendanceRosterWhere, levelScopeWhere(user, level, { ownerField: "id" }) as Prisma.UserWhereInput, ...(userId ? [{ id: userId }] : [])] };
}

/** Roster members this user can see — for the person filter. */
export async function listAttendancePeople(db: Db, user: SessionUser, level: ViewLevel): Promise<AttendancePerson[]> {
  return db.user.findMany({ where: rosterWhere(user, level), select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export async function getAttendanceSheet(db: Db, user: SessionUser, level: ViewLevel, month: string, opts: { userId?: string; now?: Date } = {}): Promise<AttendanceSheet> {
  const now = opts.now ?? new Date();
  const today = dhakaToday(now);
  const { from, to } = monthRange(month);
  const days = monthDays(month);
  const [hours, people] = await Promise.all([
    getOfficeHours(db),
    db.user.findMany({
      where: rosterWhere(user, level, opts.userId),
      select: { id: true, name: true, joinDate: true, role: { select: { label: true } }, team: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);
  const ids = people.map((p) => p.id);
  const [records, leaves] = await Promise.all([
    db.attendance.findMany({ where: { userId: { in: ids }, workDate: { gte: from, lt: to } } }),
    db.leaveRequest.findMany({ where: { userId: { in: ids }, status: "APPROVED", fromDate: { lt: to }, toDate: { gte: from } } }),
  ]);

  const rows = people.map((p) => {
    const mine = new Map(records.filter((r) => r.userId === p.id).map((r) => [dhakaDayOf(r.workDate), recordView(r)]));
    const leave = new Map<string, (typeof leaves)[number]["type"]>();
    for (const l of leaves.filter((x) => x.userId === p.id)) for (const d of daySpan(dhakaDayOf(l.fromDate), dhakaDayOf(l.toDate))) leave.set(d, l.type);
    const { days: marked, totals } = markDays({ days, today, now, hours, joinDay: dhakaDayOf(p.joinDate), records: mine, leave });
    return { userId: p.id, name: p.name, role: p.role.label, teamName: p.team?.name ?? null, days: marked, totals };
  });

  return { month, today, days: days.map((d) => ({ day: d, kind: dayKind(d, hours) })), rows, officeHours: hours };
}

const DHAKA_CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", hour12: false });

/** The report as CSV: a summary per person, then one line per person-day with times. */
export function attendanceSheetCsv(sheet: AttendanceSheet): string {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: (string | number)[][] = [
    ["Staff", "Role", "Team", "Working days", "Present", "Late", "Half day", "Absent", "Leave", "No check-out", "Late minutes", "Off days worked"],
    ...sheet.rows.map((r) => [r.name, r.role, r.teamName ?? "", r.totals.workingDays, r.totals.present, r.totals.late, r.totals.halfDay, r.totals.absent, r.totals.leave, r.totals.noCheckOut, r.totals.lateMinutes, r.totals.offDaysWorked]),
    [],
    ["Staff", "Date", "Mark", "Code", "Check-in", "Check-out", "Late minutes", "Leave type", "Corrected"],
  ];
  for (const r of sheet.rows) {
    for (const d of r.days) {
      if (d.day > sheet.today) continue;
      lines.push([
        r.name,
        d.day,
        DAY_MARK_LABELS[d.mark],
        DAY_MARK_CODES[d.mark],
        d.record ? DHAKA_CLOCK.format(new Date(d.record.checkInAt)) : "",
        d.record?.checkOutAt ? DHAKA_CLOCK.format(new Date(d.record.checkOutAt)) : "",
        d.record?.lateMinutes ?? "",
        d.leaveType ? LEAVE_TYPE_LABELS[d.leaveType] : "",
        d.record?.corrected ? d.record.correctionReason ?? "yes" : "",
      ]);
    }
  }
  return lines.map((l) => l.map(escape).join(",")).join("\n") + "\n";
}

/** Who's in today: checked in, gone home, not in yet, absent, on leave or off. */
export async function getTodayBoard(db: Db, user: SessionUser, level: ViewLevel, now = new Date()): Promise<TodayBoard> {
  const today = dhakaToday(now);
  const workDate = dhakaDayStart(today);
  const [hours, people] = await Promise.all([
    getOfficeHours(db),
    db.user.findMany({ where: rosterWhere(user, level), select: { id: true, name: true, team: { select: { name: true } } }, orderBy: { name: "asc" } }),
  ]);
  const ids = people.map((p) => p.id);
  const [records, leaves] = await Promise.all([
    db.attendance.findMany({ where: { userId: { in: ids }, workDate } }),
    db.leaveRequest.findMany({ where: { userId: { in: ids }, status: "APPROVED", fromDate: { lte: workDate }, toDate: { gte: workDate } }, select: { userId: true, type: true } }),
  ]);
  const kind = dayKind(today, hours);
  const over = isDayOver(today, today, now, hours);
  const rows: TodayBoardRow[] = people.map((p) => {
    const r = records.find((x) => x.userId === p.id);
    const leave = leaves.find((x) => x.userId === p.id)?.type ?? null;
    const state = r ? (r.checkOutAt ? "OUT" : "IN") : leave ? "LEAVE" : kind !== "WORKING" ? "OFF" : over ? "ABSENT" : "NOT_IN";
    return { userId: p.id, name: p.name, teamName: p.team?.name ?? null, state, record: r ? recordView(r) : null, leaveType: leave };
  });
  return { day: today, dayKind: kind, rows };
}

// ─── Leave lists ─────────────────────────────────────────────────────────

const leaveInclude = {
  user: { select: { name: true } },
  decidedBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
} satisfies Prisma.LeaveRequestInclude;

export async function listLeaveRequests(
  db: Db,
  user: SessionUser,
  level: ViewLevel,
  filters: { status?: LeaveStatusValue; mine?: boolean; month?: string; take?: number } = {},
): Promise<LeaveRequestView[]> {
  const hours = await getOfficeHours(db);
  const range = filters.month ? monthRange(filters.month) : null;
  const rows = await db.leaveRequest.findMany({
    where: {
      user: filters.mine ? { id: user.id } : rosterWhere(user, level),
      ...(filters.mine ? { userId: user.id } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(range ? { fromDate: { lt: range.to }, toDate: { gte: range.from } } : {}),
    },
    include: leaveInclude,
    orderBy: [{ fromDate: "desc" }, { createdAt: "desc" }],
    take: filters.take ?? 100,
  });
  return rows.map((l) => {
    const fromDay = dhakaDayOf(l.fromDate);
    const toDay = dhakaDayOf(l.toDate);
    return {
      id: l.id,
      userId: l.userId,
      userName: l.user.name,
      type: l.type,
      fromDay,
      toDay,
      workingDays: leaveWorkingDays(daySpan(fromDay, toDay), hours),
      reason: l.reason,
      status: l.status,
      decidedBy: l.decidedBy?.name ?? null,
      decidedAt: l.decidedAt?.toISOString() ?? null,
      decisionNote: l.decisionNote,
      cancelledBy: l.cancelledBy?.name ?? null,
      createdAt: l.createdAt.toISOString(),
    };
  });
}

/** What the check-in card needs for the signed-in person. `onRoster` false for the owner. */
export async function getMyDay(db: Db, userId: string, now = new Date()) {
  const today = dhakaToday(now);
  const workDate = dhakaDayStart(today);
  const [roster, hours, record, leave] = await Promise.all([
    db.user.count({ where: { AND: [{ id: userId }, attendanceRosterWhere] } }),
    getOfficeHours(db),
    db.attendance.findUnique({ where: { userId_workDate: { userId, workDate } } }),
    db.leaveRequest.findFirst({ where: { userId, status: "APPROVED", fromDate: { lte: workDate }, toDate: { gte: workDate } }, select: { type: true } }),
  ]);
  return { onRoster: roster > 0, today, hours, dayKind: dayKind(today, hours), record: record ? recordView(record) : null, leaveToday: leave?.type ?? null };
}
