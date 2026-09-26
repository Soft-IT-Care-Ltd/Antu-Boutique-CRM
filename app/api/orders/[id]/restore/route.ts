import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { restoreOrder, TrashError } from "@/lib/trash/service";

// PRD §4.18 — brings an order back out of the trash (and its customer, if
// they were deleted too). Same permission as deleting it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("order.delete");
  if (!guard.ok) return guard.response;

  const id = z.string().cuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Order not found in trash" }, { status: 404 });
  try {
    await restoreOrder(prisma, guard.user, id.data, { request });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TrashError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
