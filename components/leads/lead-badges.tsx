import { AlarmClock, CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { LEAD_STATUS_LABELS, type LeadStatusValue } from "@/lib/leads/constants";
import { followUpState, formatFollowUpTime } from "@/lib/leads/dates";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<LeadStatusValue, string> = {
  NEW: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  CONTACTED: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  FOLLOW_UP: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  NEGOTIATING: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  CONVERTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  LOST: "bg-muted text-muted-foreground",
};

export function LeadStatusBadge({ status }: { status: LeadStatusValue }) {
  return <Badge className={STATUS_CLASS[status]}>{LEAD_STATUS_LABELS[status]}</Badge>;
}

/** A follow-up time, red when overdue (PRD §4.5 "overdue follow-ups highlighted"). */
export function FollowUpTime({ dueAt, className }: { dueAt: string; className?: string }) {
  const state = followUpState(dueAt);
  const Icon = state === "overdue" ? AlarmClock : CalendarClock;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        state === "overdue" ? "font-medium text-destructive" : state === "today" ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : ""}
      {formatFollowUpTime(dueAt)}
    </span>
  );
}
