// Targets and attendance run on Dhaka calendar months, written "YYYY-MM".
// Dhaka is UTC+6 all year, so month and day boundaries are fixed offsets.
// Client- and server-safe.

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** Today's Dhaka date, YYYY-MM-DD. */
export function dhakaToday(now = new Date()): string {
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Dhaka month `now` falls in, "YYYY-MM". */
export function dhakaMonth(now = new Date()): string {
  return dhakaToday(now).slice(0, 7);
}

/** "2026-09" shifted by n months ("2026-10" for n = 1). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every day of the month, YYYY-MM-DD. */
export function monthDays(month: string): string[] {
  return Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Midnight (Dhaka) starting a YYYY-MM-DD day, as a UTC instant; offsetDays shifts it. */
export function dhakaDayStart(day: string, offsetDays = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays) - DHAKA_OFFSET_MS);
}

/** A UTC instant stored as a Dhaka midnight → its YYYY-MM-DD. */
export function dhakaDayOf(instant: Date | string): string {
  return dhakaToday(new Date(instant));
}

/** [from, to) UTC instants covering the Dhaka month. */
export function monthRange(month: string): { from: Date; to: Date } {
  return { from: dhakaDayStart(`${month}-01`), to: dhakaDayStart(`${shiftMonth(month, 1)}-01`) };
}

/**
 * Days still left to sell in the month, today included: 0 once the month
 * is over, the whole month before it starts.
 */
export function daysLeftInMonth(month: string, now = new Date()): number {
  const current = dhakaMonth(now);
  if (month < current) return 0;
  if (month > current) return daysInMonth(month);
  return daysInMonth(month) - Number(dhakaToday(now).slice(8, 10)) + 1;
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "September 2026". */
export function monthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
}

/** Months for a picker, newest first: `ahead` future months, the current one, then `back` past ones. */
export function monthOptions(current: string, back: number, ahead = 0): string[] {
  const out: string[] = [];
  for (let n = ahead; n >= -back; n--) out.push(shiftMonth(current, n));
  return out;
}
