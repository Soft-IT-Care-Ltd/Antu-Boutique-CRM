import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, dhakaDateTime, leadErrorResponse, leadId } from "@/lib/leads/http";
import { loadLeadDetail } from "@/lib/leads/queries";
import { scheduleFollowUp } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  dueAt: dhakaDateTime,
  note: z.string().trim().max(500).nullish(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("lead.edit");
  if (!guard.ok) return guard.response;

  const id = leadId.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    await scheduleFollowUp(prisma, guard.user, id.data, parsed.data);
    return NextResponse.json({ lead: await loadLeadDetail(prisma, guard.user, id.data) }, { status: 201 });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
