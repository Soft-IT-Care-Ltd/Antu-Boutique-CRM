import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { DATETIME_LOCAL_PATTERN, dhakaLocalToUtc } from "@/lib/leads/dates";
import { LeadError } from "@/lib/leads/service";

export const LEAD_VIEW_PERMISSIONS: PermissionKey[] = ["lead.view_own", "lead.view_team", "lead.view_all"];

/** A follow-up time typed in Dhaka time ("YYYY-MM-DDTHH:mm") → UTC instant. */
export const dhakaDateTime = z
  .string()
  .trim()
  .regex(DATETIME_LOCAL_PATTERN, "Pick a date and time")
  .transform((v) => dhakaLocalToUtc(v));

export const leadId = z.string().cuid();

export function badRequest(error: z.ZodError) {
  return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
}

/** Maps lead errors (and a lead that was converted twice at once) to JSON; rethrows anything else. */
export function leadErrorResponse(error: unknown): NextResponse {
  if (error instanceof LeadError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && String(error.meta?.target ?? "").includes("leadId")) {
    return NextResponse.json({ error: "This lead has already been converted to an order." }, { status: 409 });
  }
  throw error;
}
