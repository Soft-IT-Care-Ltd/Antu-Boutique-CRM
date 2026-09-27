import { Badge } from "@/components/ui/badge";
import { DAY_MARK_LABELS, LEAVE_STATUS_LABELS, type DayMark, type LeaveStatusValue } from "@/lib/attendance/constants";
import { formatMinutes } from "@/lib/attendance/rules";
import { cn } from "@/lib/utils";

// Marks always carry their word (or letter + legend), never colour alone.
export const MARK_CLASS: Record<DayMark, string> = {
  PRESENT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  LATE: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  HALF_DAY: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  ABSENT: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  LEAVE: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  WEEKLY_OFF: "bg-muted text-muted-foreground",
  HOLIDAY: "bg-muted text-muted-foreground",
  NONE: "text-muted-foreground",
};

export function DayMarkBadge({ mark, lateMinutes }: { mark: DayMark; lateMinutes?: number }) {
  return (
    <Badge className={MARK_CLASS[mark]}>
      {DAY_MARK_LABELS[mark]}
      {lateMinutes ? ` · ${formatMinutes(lateMinutes)} late` : ""}
    </Badge>
  );
}

const LEAVE_CLASS: Record<LeaveStatusValue, string> = {
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  CANCELLED: "bg-muted text-muted-foreground",
};

export function LeaveStatusBadge({ status, className }: { status: LeaveStatusValue; className?: string }) {
  return <Badge className={cn(LEAVE_CLASS[status], className)}>{LEAVE_STATUS_LABELS[status]}</Badge>;
}

const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit", hour12: true });
/** "9:58 am" in Dhaka time. */
export const formatClockTime = (iso: string) => CLOCK.format(new Date(iso));

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** "24 Sept" for a YYYY-MM-DD day. */
export const formatDay = (day: string, weekday = false) => (weekday ? DAY_WEEKDAY : DAY).format(new Date(`${day}T00:00:00Z`));
