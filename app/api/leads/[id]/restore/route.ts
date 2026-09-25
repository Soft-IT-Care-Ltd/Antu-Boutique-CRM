import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { leadErrorResponse, leadId } from "@/lib/leads/http";
import { restoreLead } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("lead.delete");
  if (!guard.ok) return guard.response;

  const id = leadId.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Lead not found in trash" }, { status: 404 });
  try {
    await restoreLead(prisma, guard.user, id.data, { request });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return leadErrorResponse(error);
  }
}
