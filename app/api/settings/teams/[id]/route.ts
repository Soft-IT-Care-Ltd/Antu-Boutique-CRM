import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { staffErrorResponse, teamSchema, updateTeam } from "@/lib/settings/staff";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("user.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = teamSchema.partial().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const team = await updateTeam(prisma, guard.user.id, id, parsed.data, request);
    return NextResponse.json({ team: { id: team.id, name: team.name } });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
