// Follow-up times are typed and shown in Dhaka time (CLAUDE.md: store UTC,
// display Asia/Dhaka). Dhaka is UTC+6 all year — no daylight saving — so the
// conversion is a fixed offset and doesn't depend on the browser's zone.
// Client- and server-safe.

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** "YYYY-MM-DDTHH:mm" typed in Dhaka time → the UTC instant. */
export function dhakaLocalToUtc(local: string): Date {
  const [day, time = "00:00"] = local.split("T");
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - DHAKA_OFFSET_MS);
}

/** A UTC instant → "YYYY-MM-DDTHH:mm" in Dhaka time, for <input type="datetime-local">. */
export function utcToDhakaLocal(instant: Date | string): string {
  return new Date(new Date(instant).getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 16);
}

/** Start of the Dhaka day `instant` falls in, plus `offsetDays`, as a UTC instant. */
export function dhakaDayStartOf(instant: Date, offsetDays = 0): Date {
  const shifted = new Date(instant.getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays) - DHAKA_OFFSET_MS);
}

export const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const DHAKA_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit", hour12: true });
const DHAKA_DAY_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** "4:30 pm" when the instant is today in Dhaka, "27 Sept, 4:30 pm" otherwise. */
export function formatFollowUpTime(instant: Date | string, now = new Date()): string {
  const when = new Date(instant);
  const sameDay = dhakaDayStartOf(when).getTime() === dhakaDayStartOf(now).getTime();
  return sameDay ? DHAKA_TIME.format(when) : DHAKA_DAY_TIME.format(when);
}

export type FollowUpState = "overdue" | "today" | "upcoming";

/** Overdue once the time has passed; "today" while still ahead but before Dhaka midnight. */
export function followUpState(dueAt: Date | string, now = new Date()): FollowUpState {
  const due = new Date(dueAt);
  if (due.getTime() < now.getTime()) return "overdue";
  return due.getTime() < dhakaDayStartOf(now, 1).getTime() ? "today" : "upcoming";
}
