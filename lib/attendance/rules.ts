import type { AttendanceStatusValue } from "@/lib/attendance/constants";
import { minutesOf, type OfficeHours } from "@/lib/attendance/office-hours";

// PRD §4.14 — late / half-day flags from the office-hour settings. Pure and
// client/server-safe so the rules are unit-tested. All times are Dhaka
// (UTC+6, no daylight saving).

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export type DayKind = "WORKING" | "WEEKLY_OFF" | "HOLIDAY";

/** Whether the office is open on a YYYY-MM-DD day. */
export function dayKind(day: string, hours: OfficeHours): DayKind {
  if (hours.holidays.includes(day)) return "HOLIDAY";
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return hours.weeklyOff.includes(weekday) ? "WEEKLY_OFF" : "WORKING";
}

/** Minutes past Dhaka midnight of `day` (can pass 1440 for a check-out after midnight). */
export function minutesIntoDay(instant: Date, day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const midnight = Date.UTC(y, m - 1, d) - DHAKA_OFFSET_MS;
  return Math.floor((instant.getTime() - midnight) / 60_000);
}

export type DayResult = { status: AttendanceStatusValue; lateMinutes: number };

/**
 * A day's status from its check-in (and check-out, once there is one).
 *
 * - Late: checked in more than the grace period after opening. The late
 *   minutes count from opening time, not from the end of the grace.
 * - Half day: checked in at or after the half-day cut-off, or checked out
 *   having worked fewer than the minimum hours.
 * - On a weekly off day or a holiday, coming in is simply Present.
 */
export function attendanceStatus(input: { day: string; checkInAt: Date; checkOutAt: Date | null }, hours: OfficeHours): DayResult {
  if (dayKind(input.day, hours) !== "WORKING") return { status: "PRESENT", lateMinutes: 0 };

  const after = minutesIntoDay(input.checkInAt, input.day) - minutesOf(hours.start);
  const lateMinutes = after > hours.lateGraceMinutes ? after : 0;

  const workedMinutes = input.checkOutAt ? (input.checkOutAt.getTime() - input.checkInAt.getTime()) / 60_000 : null;
  const halfDay = after >= hours.halfDayAfterMinutes || (workedMinutes !== null && workedMinutes < hours.halfDayMinHours * 60);

  return { status: halfDay ? "HALF_DAY" : lateMinutes > 0 ? "LATE" : "PRESENT", lateMinutes };
}

/** Whether the working day is over, so a day with no check-in counts as absent. */
export function isDayOver(day: string, today: string, now: Date, hours: OfficeHours): boolean {
  if (day < today) return true;
  if (day > today) return false;
  return minutesIntoDay(now, day) >= minutesOf(hours.end);
}

/** "1 h 25 m" / "40 m". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h} h${m ? ` ${m} m` : ""}` : `${m} m`;
}
