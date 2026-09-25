import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getClientIp } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { attendanceErrorResponse, attendanceViewLevel } from "@/lib/attendance/http";
import { correctAttendance } from "@/lib/attendance/service";
import { recordView } from "@/lib/attendance/sheet";
import { dayString } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { badRequest } from "@/lib/targets/http";

// attendance.manage — sets a day's check-in/out for someone, with a
// reason. Audit-logged with before/after.
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:45");
const schema = z.object({
  userId: z.string().cuid(),
  day: dayString,
  checkIn: clock,
  checkOut: clock.nullable(),
  reason: z.string().trim().min(3, "Say why the day is being corrected").max(300),
});

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("attendance.manage");
  if (!guard.ok) return guard.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const level = await attendanceViewLevel(guard.user);
  if (!level) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const record = await correctAttendance(prisma, guard.user, level, parsed.data, { request, ip: getClientIp(request) });
    return NextResponse.json({ record: recordView(record) });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
