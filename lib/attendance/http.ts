import "server-only";

import { NextResponse } from "next/server";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { viewLevel } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { AttendanceError } from "@/lib/attendance/service";

export const ATTENDANCE_VIEW_PERMISSIONS: PermissionKey[] = ["attendance.view_own", "attendance.view_team", "attendance.view_all"];

export const attendanceViewLevel = (user: SessionUser) => viewLevel(user, { all: "attendance.view_all", team: "attendance.view_team", own: "attendance.view_own" });

export function attendanceErrorResponse(error: unknown): NextResponse {
  if (error instanceof AttendanceError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}
