import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { createTeam, listTeams, staffErrorResponse, teamSchema } from "@/lib/settings/staff";

// PRD §4.1 teams: name, leader, members. A team is what a Team Leader's
// scope covers (lib/auth/scope.ts), so changing one is a user.edit action.

export async function GET() {
  const guard = await requirePermission("user.view");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ teams: await listTeams(prisma) });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("user.edit");
  if (!guard.ok) return guard.response;
  const parsed = teamSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const team = await createTeam(prisma, guard.user.id, parsed.data, request);
    return NextResponse.json({ team: { id: team.id, name: team.name } }, { status: 201 });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
