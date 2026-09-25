import { describe, expect, it } from "vitest";

import type { LeaveTypeValue } from "@/lib/attendance/constants";
import { daySpan, leaveWorkingDays, markDays } from "@/lib/attendance/days";
import { DEFAULT_OFFICE_HOURS, officeHoursSchema, parseOfficeHours, type OfficeHours } from "@/lib/attendance/office-hours";
import { attendanceStatus, dayKind, isDayOver } from "@/lib/attendance/rules";
import type { AttendanceRecordView } from "@/lib/attendance/types";

// 10:00–20:00, 15 min grace, half day from 12:00 or under 4 h, Friday off.
const hours: OfficeHours = { ...DEFAULT_OFFICE_HOURS, holidays: ["2026-09-16"] };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+06:00`);
const WED = "2026-09-23";

describe("office days", () => {
  it("knows weekly offs and holidays", () => {
    expect(dayKind(WED, hours)).toBe("WORKING");
    expect(dayKind("2026-09-25", hours)).toBe("WEEKLY_OFF"); // a Friday
    expect(dayKind("2026-09-16", hours)).toBe("HOLIDAY");
  });

  it("treats today as over only after closing time", () => {
    expect(isDayOver(WED, WED, at(WED, "19:59"), hours)).toBe(false);
    expect(isDayOver(WED, WED, at(WED, "20:00"), hours)).toBe(true);
    expect(isDayOver("2026-09-22", WED, at(WED, "09:00"), hours)).toBe(true);
  });
});

describe("check-in status", () => {
  it("is on time within the grace period", () => {
    expect(attendanceStatus({ day: WED, checkInAt: at(WED, "10:15"), checkOutAt: null }, hours)).toEqual({ status: "PRESENT", lateMinutes: 0 });
  });

  it("is late past the grace, counting from opening time", () => {
    expect(attendanceStatus({ day: WED, checkInAt: at(WED, "10:16"), checkOutAt: null }, hours)).toEqual({ status: "LATE", lateMinutes: 16 });
  });

  it("is a half day from the cut-off", () => {
    expect(attendanceStatus({ day: WED, checkInAt: at(WED, "12:00"), checkOutAt: null }, hours)).toEqual({ status: "HALF_DAY", lateMinutes: 120 });
  });

  it("becomes a half day when too few hours are worked", () => {
    expect(attendanceStatus({ day: WED, checkInAt: at(WED, "10:00"), checkOutAt: at(WED, "13:59") }, hours).status).toBe("HALF_DAY");
    expect(attendanceStatus({ day: WED, checkInAt: at(WED, "10:00"), checkOutAt: at(WED, "14:00") }, hours).status).toBe("PRESENT");
  });

  it("is simply present on an off day", () => {
    expect(attendanceStatus({ day: "2026-09-25", checkInAt: at("2026-09-25", "15:00"), checkOutAt: null }, hours)).toEqual({ status: "PRESENT", lateMinutes: 0 });
  });
});

describe("office-hour settings", () => {
  it("falls back to the defaults on a missing or broken value", () => {
    expect(parseOfficeHours(null)).toEqual(DEFAULT_OFFICE_HOURS);
    expect(parseOfficeHours("{nope")).toEqual(DEFAULT_OFFICE_HOURS);
  });

  it("rejects closing before opening and a cut-off inside the grace", () => {
    expect(officeHoursSchema.safeParse({ ...hours, end: "09:00" }).success).toBe(false);
    expect(officeHoursSchema.safeParse({ ...hours, halfDayAfterMinutes: 10 }).success).toBe(false);
  });
});

describe("the monthly sheet", () => {
  const rec = (day: string, status: AttendanceRecordView["status"], lateMinutes = 0, checkOut: string | null = "19:00"): [string, AttendanceRecordView] => [
    day,
    { id: day, day, checkInAt: at(day, "10:00").toISOString(), checkOutAt: checkOut ? at(day, checkOut).toISOString() : null, status, lateMinutes, corrected: false, correctionReason: null },
  ];

  it("derives absent, leave, off days and blanks", () => {
    const days = daySpan("2026-09-21", "2026-09-27"); // Mon → Sun
    const today = "2026-09-24"; // Thursday, before closing
    const { days: marked, totals } = markDays({
      days,
      today,
      now: at(today, "11:00"),
      hours,
      joinDay: "2026-09-01",
      records: new Map([rec("2026-09-21", "PRESENT"), rec("2026-09-22", "LATE", 30, null)]),
      leave: new Map<string, LeaveTypeValue>([["2026-09-27", "SICK"]]),
    });
    expect(marked.map((d) => d.mark)).toEqual(["PRESENT", "LATE", "ABSENT", "NONE", "WEEKLY_OFF", "NONE", "LEAVE"]);
    expect(marked[1].noCheckOut).toBe(true);
    // Future leave shows but isn't counted yet; today (not over) isn't a working day yet.
    expect(totals).toMatchObject({ workingDays: 3, present: 2, late: 1, absent: 1, leave: 0, noCheckOut: 1, lateMinutes: 30 });
  });

  it("leaves days before joining blank and counts leave on working days only", () => {
    const { days: marked, totals } = markDays({
      days: ["2026-09-24", "2026-09-25", "2026-09-26"],
      today: "2026-09-30",
      now: at("2026-09-30", "21:00"),
      hours,
      joinDay: "2026-09-25",
      records: new Map(),
      leave: new Map<string, LeaveTypeValue>([["2026-09-25", "CASUAL"], ["2026-09-26", "CASUAL"]]),
    });
    expect(marked.map((d) => d.mark)).toEqual(["NONE", "WEEKLY_OFF", "LEAVE"]);
    expect(totals.leave).toBe(1);
    expect(leaveWorkingDays(["2026-09-25", "2026-09-26"], hours)).toBe(1);
  });
});
