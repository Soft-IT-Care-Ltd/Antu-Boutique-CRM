import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { LEAVE_STATUS_VALUES, LEAVE_TYPE_VALUES } from "@/lib/attendance/constants";
import { ATTENDANCE_VIEW_PERMISSIONS, attendanceErrorResponse, attendanceViewLevel } from "@/lib/attendance/http";
import { requestLeave } from "@/lib/attendance/service";
import { listLeaveRequests } from "@/lib/attendance/sheet";
import { dayString } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { badRequest, monthString } from "@/lib/targets/http";

// PRD §4.14 leave requests. Anyone asks for their own; the list is scoped
// like attendance (own / team / all).

const listSchema = z.object({
  status: z.enum(LEAVE_STATUS_VALUES).optional(),
  mine: z.enum(["1", "0"]).optional(),
  month: monthString.optional(),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(ATTENDANCE_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const level = (await attendanceViewLevel(guard.user))!;
  const requests = await listLeaveRequests(prisma, guard.user, level, { status: parsed.data.status, month: parsed.data.month, mine: parsed.data.mine === "1" });
  return NextResponse.json({ requests });
}

const createSchema = z
  .object({
    type: z.enum(LEAVE_TYPE_VALUES),
    fromDay: dayString,
    toDay: dayString,
    reason: z.string().trim().min(3, "Give a reason for the leave").max(500),
  })
  .refine((v) => v.toDay >= v.fromDay, { message: "The last day is before the first day", path: ["toDay"] });

export async function POST(request: NextRequest) {
  const guard = await requirePermission("attendance.mark");
  if (!guard.ok) return guard.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const leave = await requestLeave(prisma, guard.user, parsed.data);
    return NextResponse.json({ id: leave.id }, { status: 201 });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
