import { AlarmClock, CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { LEAD_STATUS_LABELS, type LeadStatusValue } from "@/lib/leads/constants";
import { followUpState, formatFollowUpTime } from "@/lib/leads/dates";
import type { BadgeTone } from "@/lib/ui/status-tone";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<LeadStatusValue, BadgeTone> = {
  NEW: "info",
  CONTACTED: "default",
  FOLLOW_UP: "warning",
  NEGOTIATING: "soft",
  CONVERTED: "success",
  LOST: "neutral",
};

export function LeadStatusBadge({ status }: { status: LeadStatusValue }) {
  return <Badge variant={STATUS_TONE[status]}>{LEAD_STATUS_LABELS[status]}</Badge>;
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
