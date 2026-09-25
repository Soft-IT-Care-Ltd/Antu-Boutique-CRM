import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { LEAD_LOST_REASON_VALUES, LEAD_STATUS_VALUES } from "@/lib/leads/constants";
import { badRequest, leadErrorResponse, leadId } from "@/lib/leads/http";
import { loadLeadDetail } from "@/lib/leads/queries";
import { changeLeadStatus } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";

// PRD §4.5 funnel. LOST needs a reason (and a note for "Other");
// CONVERTED is refused here — it is set by placing the lead's order.
const schema = z
  .object({
    status: z.enum(LEAD_STATUS_VALUES),
    lostReason: z.enum(LEAD_LOST_REASON_VALUES).nullish(),
    lostNote: z.string().trim().max(500).nullish(),
  })
  .refine((d) => d.status !== "LOST" || Boolean(d.lostReason), { message: "Pick why the lead was lost", path: ["lostReason"] })
  .refine((d) => d.lostReason !== "OTHER" || Boolean(d.lostNote), { message: "Write down why the lead was lost", path: ["lostNote"] });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("lead.edit");
  if (!guard.ok) return guard.response;

  const id = leadId.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  try {
    await changeLeadStatus(prisma, guard.user, id.data, parsed.data, { request });
    return NextResponse.json({ lead: await loadLeadDetail(prisma, guard.user, id.data) });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
