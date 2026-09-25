import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/constants";
import { badRequest, LEAD_VIEW_PERMISSIONS, leadErrorResponse, leadId } from "@/lib/leads/http";
import { loadLeadDetail } from "@/lib/leads/queries";
import { deleteLead, updateLead } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const guard = await requirePermission(LEAD_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const id = leadId.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  const lead = await loadLeadDetail(prisma, guard.user, id.data);
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  return NextResponse.json({ lead });
}

const updateSchema = z
  .object({
    name: z.string().trim().min(1, "Enter the person's name").max(150),
    phone: z.string().trim().max(20).nullable(),
    source: z.enum(LEAD_SOURCE_VALUES),
    campaign: z.string().trim().max(100).nullable(),
    interest: z.string().trim().max(500).nullable(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, "Nothing to change");

export async function PATCH(request: NextRequest, { params }: Params) {
  const guard = await requirePermission("lead.edit");
  if (!guard.ok) return guard.response;

  const id = leadId.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    await updateLead(prisma, guard.user, id.data, parsed.data, { request });
    return NextResponse.json({ lead: await loadLeadDetail(prisma, guard.user, id.data) });
  } catch (error) {
    return leadErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const guard = await requirePermission("lead.delete");
  if (!guard.ok) return guard.response;

  const id = leadId.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  try {
    await deleteLead(prisma, guard.user, id.data, { request });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
