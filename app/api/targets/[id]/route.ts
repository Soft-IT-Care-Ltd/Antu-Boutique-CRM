import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { targetErrorResponse } from "@/lib/targets/http";
import { deleteTarget } from "@/lib/targets/service";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("target.manage");
  if (!guard.ok) return guard.response;
  const id = z.string().cuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Target not found" }, { status: 404 });
  try {
    await deleteTarget(prisma, guard.user, id.data, { request });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return targetErrorResponse(error);
  }
}
