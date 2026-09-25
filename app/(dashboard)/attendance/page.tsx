import { AttendanceHeader } from "@/components/attendance/attendance-header";
import { DayMarkBadge, formatClockTime } from "@/components/attendance/attendance-badges";
import { CheckInCard } from "@/components/attendance/check-in-card";
import { MonthStrip, TotalsRow } from "@/components/attendance/month-strip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { LEAVE_TYPE_LABELS } from "@/lib/attendance/constants";
import { attendanceViewLevel } from "@/lib/attendance/http";
import { getAttendanceSheet, getMyDay, getTodayBoard } from "@/lib/attendance/sheet";
import type { TodayState } from "@/lib/attendance/types";
import { prisma } from "@/lib/prisma";
import { dhakaMonth, monthLabel } from "@/lib/targets/month";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<TodayState, string> = { IN: "In", OUT: "Gone home", NOT_IN: "Not in yet", ABSENT: "Absent", LEAVE: "On leave", OFF: "Off today" };

// PRD §4.14 — check in / out, my month so far, and (for a team leader or
// manager) who's in today. Scoped by attendance.view_all / _team / _own.
export default async function AttendancePage() {
  const user = await guardPage("/attendance");
  const [level, canMark, me] = await Promise.all([attendanceViewLevel(user), can(user, "attendance.mark"), getMyDay(prisma, user.id)]);
  const month = dhakaMonth();
  const [mine, board] = await Promise.all([
    me.onRoster ? getAttendanceSheet(prisma, user, "own", month, { userId: user.id }) : Promise.resolve(null),
    level && level !== "own" ? getTodayBoard(prisma, user, level) : Promise.resolve(null),
  ]);
  const myRow = mine?.rows[0];
  const counts = board ? (["IN", "OUT", "NOT_IN", "ABSENT", "LEAVE", "OFF"] as TodayState[]).map((s) => [s, board.rows.filter((r) => r.state === s).length] as const).filter(([, n]) => n > 0) : [];

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <AttendanceHeader title="Attendance" description="Check in when you arrive, check out when you leave. Late and half days follow the office hours." />

      {me.onRoster && canMark ? <CheckInCard record={me.record} hours={me.hours} dayKind={me.dayKind} leaveToday={me.leaveToday} /> : null}

      {myRow ? (
        <Card>
          <CardHeader>
            <CardTitle>My {monthLabel(month)} so far</CardTitle>
            <CardDescription>Absent means a working day with no check-in and no approved leave.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <TotalsRow totals={myRow.totals} />
            <MonthStrip days={myRow.days} />
          </CardContent>
        </Card>
      ) : null}

      {board ? (
        <Card>
          <CardHeader>
            <CardTitle>Who&apos;s in today</CardTitle>
            <CardDescription>{counts.length ? counts.map(([s, n]) => `${n} ${STATE_LABEL[s].toLowerCase()}`).join(" · ") : "No staff to show."}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff</TableHead>
                    <TableHead>Today</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.rows.map((r) => (
                    <TableRow key={r.userId}>
                      <TableCell>
                        <span className="font-medium">{r.name}</span>
                        {r.teamName ? <span className="block text-xs text-muted-foreground">{r.teamName}</span> : null}
                      </TableCell>
                      <TableCell>
                        {r.record ? (
                          <DayMarkBadge mark={r.record.status} lateMinutes={r.record.lateMinutes} />
                        ) : r.state === "ABSENT" ? (
                          <DayMarkBadge mark="ABSENT" />
                        ) : r.state === "LEAVE" ? (
                          <DayMarkBadge mark="LEAVE" />
                        ) : (
                          <Badge variant="outline">{STATE_LABEL[r.state]}</Badge>
                        )}
                        {r.leaveType && r.record ? <span className="ml-1 text-xs text-muted-foreground">({LEAVE_TYPE_LABELS[r.leaveType]} leave)</span> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.record ? formatClockTime(r.record.checkInAt) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.record?.checkOutAt ? formatClockTime(r.record.checkOutAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!me.onRoster && !board ? <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">Attendance isn&apos;t kept for this account.</div> : null}
    </div>
  );
}
