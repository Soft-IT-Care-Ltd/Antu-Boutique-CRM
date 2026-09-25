import { NextResponse, type NextRequest } from "next/server";

import { getClientIp } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { attendanceErrorResponse } from "@/lib/attendance/http";
import { checkOut } from "@/lib/attendance/service";
import { recordView } from "@/lib/attendance/sheet";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const guard = await requirePermission("attendance.mark");
  if (!guard.ok) return guard.response;
  try {
    const record = await checkOut(prisma, guard.user, { ip: getClientIp(request) });
    return NextResponse.json({ record: recordView(record) });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
