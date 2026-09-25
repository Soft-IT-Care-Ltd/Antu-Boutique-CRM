import { NextResponse, type NextRequest } from "next/server";

import { getClientIp } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { attendanceErrorResponse } from "@/lib/attendance/http";
import { checkIn } from "@/lib/attendance/service";
import { recordView } from "@/lib/attendance/sheet";
import { prisma } from "@/lib/prisma";

// PRD §4.14 — checks the signed-in person in, at the server's clock. No
// body: nobody checks in for someone else (a manager corrects instead).
export async function POST(request: NextRequest) {
  const guard = await requirePermission("attendance.mark");
  if (!guard.ok) return guard.response;
  try {
    const record = await checkIn(prisma, guard.user, { ip: getClientIp(request) });
    return NextResponse.json({ record: recordView(record) }, { status: 201 });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
