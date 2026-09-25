import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { ATTENDANCE_VIEW_PERMISSIONS, attendanceViewLevel } from "@/lib/attendance/http";
import { attendanceSheetCsv, getAttendanceSheet } from "@/lib/attendance/sheet";
import { prisma } from "@/lib/prisma";
import { badRequest, monthString } from "@/lib/targets/http";
import { dhakaMonth } from "@/lib/targets/month";

// PRD §4.14 monthly attendance report per staff member, scoped by
// attendance.view_all / _team / _own. CSV needs report.export and carries
// exactly what the screen shows.
const querySchema = z.object({
  month: monthString.optional(),
  userId: z.string().cuid().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(ATTENDANCE_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const month = parsed.data.month ?? dhakaMonth();
  const level = (await attendanceViewLevel(guard.user))!;
  const sheet = await getAttendanceSheet(prisma, guard.user, level, month, { userId: parsed.data.userId });

  if (parsed.data.format === "csv") {
    if (!(await can(guard.user, "report.export"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return new NextResponse(attendanceSheetCsv(sheet), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="attendance-${month}.csv"` },
    });
  }
  return NextResponse.json({ sheet });
}
