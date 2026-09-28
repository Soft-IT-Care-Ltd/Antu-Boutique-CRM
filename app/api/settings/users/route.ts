import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { createUser, createUserSchema, listStaff, staffErrorResponse } from "@/lib/settings/staff";
import { paginationQuery } from "@/lib/list/pagination";

// PRD §4.1 staff accounts (Settings → Users). Never returns a password hash.

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  roleId: z.string().trim().max(50).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  ...paginationQuery,
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("user.view");
  if (!guard.ok) return guard.response;
  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  return NextResponse.json(await listStaff(prisma, parsed.data));
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("user.create");
  if (!guard.ok) return guard.response;
  const parsed = createUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const user = await createUser(prisma, guard.user.id, parsed.data, request);
    return NextResponse.json({ user: { id: user.id, name: user.name } }, { status: 201 });
  } catch (error) {
    return staffErrorResponse(error);
  }
}
