import { Suspense } from "react";
import { z } from "zod";

import { AttendanceHeader } from "@/components/attendance/attendance-header";
import { AttendanceReport } from "@/components/attendance/attendance-report";
import { MonthPicker } from "@/components/targets/month-picker";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { attendanceViewLevel } from "@/lib/attendance/http";
import { getAttendanceSheet, listAttendancePeople } from "@/lib/attendance/sheet";
import { prisma } from "@/lib/prisma";
import { dhakaMonth, MONTH_PATTERN, monthOptions } from "@/lib/targets/month";

export const dynamic = "force-dynamic";

// PRD §4.14 monthly attendance report per staff member — staff see their
// own, a team leader the team, Admin/Manager everyone.
export default async function AttendanceReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/attendance");
  const params = await searchParams;
  const current = dhakaMonth();
  const month = z.string().regex(MONTH_PATTERN).refine((m) => m <= current).catch(current).parse(params.month);
  const userId = z.string().cuid().optional().catch(undefined).parse(params.userId) ?? null;
  const level = (await attendanceViewLevel(user))!;
  const [sheet, people, canExport, canCorrect] = await Promise.all([
    getAttendanceSheet(prisma, user, level, month, { userId: userId ?? undefined }),
    listAttendancePeople(prisma, user, level),
    can(user, "report.export"),
    can(user, "attendance.manage"),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <AttendanceHeader
        title="Monthly report"
        description="Present, late, half day, absent and leave — per staff member, day by day."
        actions={
          <Suspense>
            <MonthPicker month={month} options={monthOptions(current, 11)} />
          </Suspense>
        }
      />
      <Suspense>
        <AttendanceReport sheet={sheet} people={people} userId={userId} canExport={canExport} canCorrect={canCorrect} />
      </Suspense>
    </div>
  );
}
