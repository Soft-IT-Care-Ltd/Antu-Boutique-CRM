import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { shelfErrorResponse } from "@/lib/shelves/http";
import { writeOffMiss } from "@/lib/shelves/service";

// C4b — a manager writes off units a shelf count didn't find: they leave
// the location's stock as a Stock shortage at cost (inventory.adjust).

const schema = z.object({ reason: z.string().trim().min(3, "Say why it's written off").max(500) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("inventory.adjust");
  if (!guard.ok) return guard.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const { id } = await params;
  try {
    const result = await prisma.$transaction((tx) => writeOffMiss(tx, guard.user, id, parsed.data.reason, { request }), { timeout: 30_000 });
    return NextResponse.json({ result });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
