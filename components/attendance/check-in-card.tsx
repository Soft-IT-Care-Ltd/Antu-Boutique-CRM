"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, LogIn, LogOut } from "lucide-react";

import { DayMarkBadge, formatClockTime } from "@/components/attendance/attendance-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeaveTypeValue } from "@/lib/attendance/constants";
import { LEAVE_TYPE_LABELS } from "@/lib/attendance/constants";
import { formatClock, type OfficeHours } from "@/lib/attendance/office-hours";
import type { DayKind } from "@/lib/attendance/rules";
import { formatMinutes } from "@/lib/attendance/rules";
import type { AttendanceRecordView } from "@/lib/attendance/types";
import { ApiError, fetchJson } from "@/lib/orders/client";

/**
 * PRD §4.14 check-in / check-out. One tap each; the time is the server's,
 * never the phone's. Late / half day is worked out from the office hours.
 */
export function CheckInCard({ record, hours, dayKind, leaveToday }: { record: AttendanceRecordView | null; hours: OfficeHours; dayKind: DayKind; leaveToday: LeaveTypeValue | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "check-in" | "check-out") {
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/attendance/${kind}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save — try again.");
    } finally {
      setBusy(false);
    }
  }

  const note =
    dayKind === "HOLIDAY" ? "Today is a holiday." : dayKind === "WEEKLY_OFF" ? "Today is a weekly off day." : leaveToday ? `You're on ${LEAVE_TYPE_LABELS[leaveToday].toLowerCase()} leave today.` : null;
  const worked = record?.checkOutAt ? (new Date(record.checkOutAt).getTime() - new Date(record.checkInAt).getTime()) / 60_000 : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>My attendance today</CardTitle>
        <CardDescription>
          Office hours {formatClock(hours.start)} – {formatClock(hours.end)} · late after {hours.lateGraceMinutes} min
          {note ? ` · ${note}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {record ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <DayMarkBadge mark={record.status} lateMinutes={record.lateMinutes} />
            <span>
              In <span className="font-medium tabular-nums">{formatClockTime(record.checkInAt)}</span>
            </span>
            <span>
              Out <span className="font-medium tabular-nums">{record.checkOutAt ? formatClockTime(record.checkOutAt) : "—"}</span>
            </span>
            {worked !== null ? <span className="text-muted-foreground">{formatMinutes(worked)} worked</span> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">You haven&apos;t checked in yet.</p>
        )}
        <div className="flex items-center gap-3">
          {!record ? (
            <Button size="lg" onClick={() => act("check-in")} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
              Check in
            </Button>
          ) : !record.checkOutAt ? (
            <Button size="lg" variant="outline" onClick={() => act("check-out")} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <LogOut />}
              Check out
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Done for today. A wrong time can be corrected by a manager.</p>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
