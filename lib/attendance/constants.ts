// PRD §4.14 — attendance and leave. Client- and server-safe (no Prisma
// import), mirrored from the AttendanceStatus / LeaveType / LeaveStatus enums.

export const ATTENDANCE_STATUS_VALUES = ["PRESENT", "LATE", "HALF_DAY"] as const;
export type AttendanceStatusValue = (typeof ATTENDANCE_STATUS_VALUES)[number];

export const LEAVE_TYPE_VALUES = ["CASUAL", "SICK", "ANNUAL", "UNPAID", "OTHER"] as const;
export type LeaveTypeValue = (typeof LEAVE_TYPE_VALUES)[number];

export const LEAVE_TYPE_LABELS: Record<LeaveTypeValue, string> = {
  CASUAL: "Casual",
  SICK: "Sick",
  ANNUAL: "Annual",
  UNPAID: "Unpaid",
  OTHER: "Other",
};

export const LEAVE_STATUS_VALUES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type LeaveStatusValue = (typeof LEAVE_STATUS_VALUES)[number];

export const LEAVE_STATUS_LABELS: Record<LeaveStatusValue, string> = {
  PENDING: "Waiting for approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

/**
 * One day on the monthly sheet. PRESENT / LATE / HALF_DAY come from the
 * day's check-in; the rest are derived (lib/attendance/sheet.ts).
 */
export const DAY_MARKS = ["PRESENT", "LATE", "HALF_DAY", "ABSENT", "LEAVE", "WEEKLY_OFF", "HOLIDAY", "NONE"] as const;
export type DayMark = (typeof DAY_MARKS)[number];

export const DAY_MARK_LABELS: Record<DayMark, string> = {
  PRESENT: "Present",
  LATE: "Late",
  HALF_DAY: "Half day",
  ABSENT: "Absent",
  LEAVE: "Leave",
  WEEKLY_OFF: "Weekly off",
  HOLIDAY: "Holiday",
  NONE: "—",
};

/** The letter printed in a sheet cell. */
export const DAY_MARK_CODES: Record<DayMark, string> = {
  PRESENT: "P",
  LATE: "L",
  HALF_DAY: "H",
  ABSENT: "A",
  LEAVE: "LV",
  WEEKLY_OFF: "O",
  HOLIDAY: "HO",
  NONE: "",
};

/** How far back leave may be asked for (sick yesterday), and how far ahead. */
export const LEAVE_BACKDATE_DAYS = 30;
export const LEAVE_AHEAD_DAYS = 365;
export const MAX_LEAVE_DAYS = 60;
