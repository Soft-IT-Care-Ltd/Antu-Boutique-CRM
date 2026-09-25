import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, dhakaDateTime, leadErrorResponse } from "@/lib/leads/http";
import { loadLeadDetail } from "@/lib/leads/queries";
import { completeFollowUp } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";

// Marks a follow-up done, with what happened, and optionally sets the next one.
const schema = z.object({
  outcome: z.string().trim().max(500).nullish(),
  next: z.object({ dueAt: dhakaDateTime, note: z.string().trim().max(500).nullish() }).nullish(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ followUpId: string }> }) {
  const guard = await requirePermission("lead.edit");
  if (!guard.ok) return guard.response;

  const id = z.string().cuid().safeParse((await params).followUpId);
  if (!id.success) return NextResponse.json({ error: "Follow-up not found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const { leadId } = await completeFollowUp(prisma, guard.user, id.data, parsed.data);
    return NextResponse.json({ lead: await loadLeadDetail(prisma, guard.user, leadId) });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
