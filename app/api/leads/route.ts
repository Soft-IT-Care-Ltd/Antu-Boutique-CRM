import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { LEAD_FOLLOW_UP_FILTERS, LEAD_SOURCE_VALUES, LEAD_STATUS_VALUES } from "@/lib/leads/constants";
import { badRequest, dhakaDateTime, LEAD_VIEW_PERMISSIONS, leadErrorResponse } from "@/lib/leads/http";
import { listLeads } from "@/lib/leads/queries";
import { createLead } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  // "all" is the same as leaving it out.
  status: z
    .enum([...LEAD_STATUS_VALUES, "open", "all"])
    .optional()
    .transform((v) => (v === "all" ? undefined : v)),
  source: z.enum(LEAD_SOURCE_VALUES).optional(),
  ownerId: z.string().cuid().optional(),
  followUp: z.enum(LEAD_FOLLOW_UP_FILTERS).optional(),
  campaign: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(LEAD_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const { page, pageSize, ...filters } = parsed.data;

  const result = await listLeads(prisma, guard.user, filters, { page, pageSize });
  return NextResponse.json({ ...result, page, pageSize });
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Enter the person's name").max(150),
  phone: z.string().trim().max(20).nullish(),
  source: z.enum(LEAD_SOURCE_VALUES, { error: "Pick where the lead came from" }),
  campaign: z.string().trim().max(100).nullish(),
  interest: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  followUpAt: dhakaDateTime.nullish(),
  followUpNote: z.string().trim().max(500).nullish(),
});

export async function POST(request: NextRequest) {
  const guard = await requirePermission("lead.create");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const lead = await createLead(prisma, guard.user, parsed.data, { request });
    return NextResponse.json({ id: lead.id }, { status: 201 });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
