// JSON shapes the attendance screens and API share. Instants are ISO
// strings (shown in Dhaka time), days are YYYY-MM-DD.

import type { AttendanceStatusValue, DayMark, LeaveStatusValue, LeaveTypeValue } from "@/lib/attendance/constants";
import type { OfficeHours } from "@/lib/attendance/office-hours";
import type { DayKind } from "@/lib/attendance/rules";

export type AttendanceRecordView = {
  id: string;
  day: string;
  checkInAt: string;
  checkOutAt: string | null;
  status: AttendanceStatusValue;
  lateMinutes: number;
  corrected: boolean;
  correctionReason: string | null;
};

export type AttendanceDay = {
  day: string;
  mark: DayMark;
  record: AttendanceRecordView | null;
  leaveType: LeaveTypeValue | null;
  /** Came in on a weekly off day or a holiday. */
  workedOffDay: boolean;
  /** Checked in on an earlier day and never checked out. */
  noCheckOut: boolean;
};

export type AttendanceTotals = {
  workingDays: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  leave: number;
  noCheckOut: number;
  lateMinutes: number;
  offDaysWorked: number;
};

export type AttendanceSheetRow = { userId: string; name: string; role: string; teamName: string | null; days: AttendanceDay[]; totals: AttendanceTotals };

export type AttendanceSheet = {
  month: string;
  today: string;
  days: { day: string; kind: DayKind }[];
  rows: AttendanceSheetRow[];
  officeHours: OfficeHours;
};

export type TodayState = "IN" | "OUT" | "NOT_IN" | "ABSENT" | "LEAVE" | "OFF";

export type TodayBoardRow = {
  userId: string;
  name: string;
  teamName: string | null;
  state: TodayState;
  record: AttendanceRecordView | null;
  leaveType: LeaveTypeValue | null;
};

export type TodayBoard = { day: string; dayKind: DayKind; rows: TodayBoardRow[] };

export type LeaveRequestView = {
  id: string;
  userId: string;
  userName: string;
  type: LeaveTypeValue;
  fromDay: string;
  toDay: string;
  /** Working days it covers (weekly offs and holidays left out). */
  workingDays: number;
  reason: string;
  status: LeaveStatusValue;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledBy: string | null;
  createdAt: string;
};

export type AttendancePerson = { id: string; name: string };
