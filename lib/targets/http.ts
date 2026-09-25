import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { viewLevel } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { MONTH_PATTERN } from "@/lib/targets/month";
import { TargetError } from "@/lib/targets/service";

export const TARGET_VIEW_PERMISSIONS: PermissionKey[] = ["target.view_own", "target.view_team", "target.view_all"];

export const targetViewLevel = (user: SessionUser) => viewLevel(user, { all: "target.view_all", team: "target.view_team", own: "target.view_own" });

export const monthString = z.string().regex(MONTH_PATTERN, "Pick a month (YYYY-MM)");

export function badRequest(error: z.ZodError) {
  return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
}

export function targetErrorResponse(error: unknown): NextResponse {
  if (error instanceof TargetError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}
