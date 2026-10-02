import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { shelfErrorResponse } from "@/lib/shelves/http";
import { startShelfCount } from "@/lib/shelves/service";

// C4b — start counting one shelf (or join the count already open on it).

const schema = z.object({ shelfId: z.string().trim().min(1).max(50) });

export async function POST(request: NextRequest) {
  const guard = await requirePermission("stock.count");
  if (!guard.ok) return guard.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Pick a shelf" }, { status: 400 });
  try {
    const count = await prisma.$transaction((tx) => startShelfCount(tx, guard.user, parsed.data.shelfId));
    return NextResponse.json({ count }, { status: 201 });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
