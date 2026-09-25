import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { ATTENDANCE_VIEW_PERMISSIONS, attendanceViewLevel } from "@/lib/attendance/http";
import { todayRecord } from "@/lib/attendance/service";
import { getTodayBoard, recordView } from "@/lib/attendance/sheet";
import { prisma } from "@/lib/prisma";

// The caller's own day, plus — for a team leader or manager — who's in.
export async function GET() {
  const guard = await requirePermission(ATTENDANCE_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const level = (await attendanceViewLevel(guard.user))!;
  const mine = await todayRecord(prisma, guard.user.id);
  const board = level === "own" ? null : await getTodayBoard(prisma, guard.user, level);
  return NextResponse.json({ record: mine ? recordView(mine) : null, board });
}
