import type { DayMark, LeaveTypeValue } from "@/lib/attendance/constants";
import type { OfficeHours } from "@/lib/attendance/office-hours";
import { dayKind, isDayOver } from "@/lib/attendance/rules";
import type { AttendanceDay, AttendanceRecordView, AttendanceTotals } from "@/lib/attendance/types";

// One person's month, day by day (PRD §4.14 "reflected in the attendance
// sheet"). Pure, so the derived marks are unit-tested:
//
// - a day with a check-in shows its recorded status (Present / Late / Half day);
// - otherwise approved leave on a working day shows Leave;
// - otherwise a weekly off day or holiday shows as such;
// - otherwise a working day that is over is Absent. Today before closing
//   time, days still to come, and days before the person joined are blank.
//
// Totals count the days so far (today included once it has a mark).

export function markDays(input: {
  days: string[];
  today: string;
  now: Date;
  hours: OfficeHours;
  joinDay: string;
  records: Map<string, AttendanceRecordView>;
  leave: Map<string, LeaveTypeValue>;
}): { days: AttendanceDay[]; totals: AttendanceTotals } {
  const totals: AttendanceTotals = { workingDays: 0, present: 0, late: 0, halfDay: 0, absent: 0, leave: 0, noCheckOut: 0, lateMinutes: 0, offDaysWorked: 0 };
  const out: AttendanceDay[] = [];

  for (const day of input.days) {
    const kind = dayKind(day, input.hours);
    const record = input.records.get(day) ?? null;
    const leaveType = input.leave.get(day) ?? null;
    let mark: DayMark = "NONE";

    if (day < input.joinDay) mark = "NONE";
    else if (record) mark = record.status;
    else if (leaveType && kind === "WORKING") mark = "LEAVE";
    else if (kind !== "WORKING") mark = kind;
    else if (isDayOver(day, input.today, input.now, input.hours)) mark = "ABSENT";

    const workedOffDay = Boolean(record) && kind !== "WORKING";
    const noCheckOut = Boolean(record && !record.checkOutAt && day < input.today);
    out.push({ day, mark, record, leaveType, workedOffDay, noCheckOut });

    if (day > input.today) continue;
    if (kind === "WORKING" && mark !== "NONE") totals.workingDays += 1;
    if (record) {
      totals.present += 1;
      if (record.lateMinutes > 0) totals.late += 1;
      totals.lateMinutes += record.lateMinutes;
      if (record.status === "HALF_DAY") totals.halfDay += 1;
      if (workedOffDay) totals.offDaysWorked += 1;
      if (noCheckOut) totals.noCheckOut += 1;
    }
    if (mark === "ABSENT") totals.absent += 1;
    if (mark === "LEAVE") totals.leave += 1;
  }
  return { days: out, totals };
}

/** Working days a leave covers — weekly offs and holidays don't use leave. */
export function leaveWorkingDays(days: string[], hours: OfficeHours): number {
  return days.filter((d) => dayKind(d, hours) === "WORKING").length;
}

/** Every YYYY-MM-DD from `from` to `to`, both included. */
export function daySpan(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
