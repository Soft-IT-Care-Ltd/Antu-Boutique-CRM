// PRD §4.14 / §4.17 "office hours and late rule" — what turns a check-in
// time into Present / Late / Half day. Kept as one JSON value in `settings`
// (lib/attendance/settings.ts). Client- and server-safe.

import { z } from "zod";

export const OFFICE_HOURS_SETTING_KEY = "attendance_office_hours";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const officeHoursSchema = z
  .object({
    /** Office opens / closes, Dhaka time "HH:mm". */
    start: z.string().regex(TIME, "Use a 24-hour time like 10:00"),
    end: z.string().regex(TIME, "Use a 24-hour time like 20:00"),
    /** Minutes after opening before a check-in counts as late. */
    lateGraceMinutes: z.coerce.number().int().min(0).max(180),
    /** A check-in this many minutes after opening or later is a half day. */
    halfDayAfterMinutes: z.coerce.number().int().min(1).max(720),
    /** Fewer hours than this between check-in and check-out is a half day. */
    halfDayMinHours: z.coerce.number().min(0.5).max(12),
    /** Days the office is shut every week: 0 = Sunday … 6 = Saturday. */
    weeklyOff: z.array(z.number().int().min(0).max(6)).max(6),
    /** Public holidays, YYYY-MM-DD. */
    holidays: z.array(z.string().regex(DAY, "Holidays are dates")).max(100),
  })
  .refine((o) => o.end > o.start, { message: "Closing time must be after opening time", path: ["end"] })
  .refine((o) => o.halfDayAfterMinutes > o.lateGraceMinutes, { message: "The half-day cut-off must come after the late grace period", path: ["halfDayAfterMinutes"] });

export type OfficeHours = z.infer<typeof officeHoursSchema>;

/** 10 am to 8 pm, 15 minutes' grace, half day from noon or under 4 hours worked, Friday off. */
export const DEFAULT_OFFICE_HOURS: OfficeHours = {
  start: "10:00",
  end: "20:00",
  lateGraceMinutes: 15,
  halfDayAfterMinutes: 120,
  halfDayMinHours: 4,
  weeklyOff: [5],
  holidays: [],
};

/** Parses the stored value, falling back to the defaults if it is missing or broken. */
export function parseOfficeHours(raw: string | null): OfficeHours {
  if (!raw) return DEFAULT_OFFICE_HOURS;
  try {
    const parsed = officeHoursSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_OFFICE_HOURS;
  } catch {
    return DEFAULT_OFFICE_HOURS;
  }
}

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** "10:00" → "10:00 am". */
export function formatClock(hhmm: string): string {
  const total = minutesOf(hhmm);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
