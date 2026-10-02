import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { shelfErrorResponse } from "@/lib/shelves/http";
import { cancelShelfCount, finishShelfCount, getShelfCountView, scanShelfCount, setShelfCountQty } from "@/lib/shelves/service";

// C4b — one shelf count: read it, scan into it, finish or cancel it.
// Finishing never changes stock (only shelf figures), so the counter
// finishes it — stock.count + the location, checked in the service.

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scan"), code: z.string().min(1, "Scan or type a tag").max(60) }),
  z.object({ action: z.literal("setQty"), variantId: z.string().trim().min(1).max(50), qty: z.number().int("Whole numbers only").min(0).max(100_000) }),
  z.object({ action: z.literal("finish") }),
  z.object({ action: z.literal("cancel") }),
]);

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("stock.count");
  if (!guard.ok) return guard.response;
  const count = await getShelfCountView(prisma, guard.user, (await params).id);
  if (!count) return NextResponse.json({ error: "Shelf count not found" }, { status: 404 });
  return NextResponse.json({ count });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("stock.count");
  if (!guard.ok) return guard.response;
  const { id: countId } = await params;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const input = parsed.data;
  const user = guard.user;
  try {
    let scan: { message: string } | null = null;
    let result: unknown = null;
    await prisma.$transaction(
      async (tx) => {
        if (input.action === "scan") scan = await scanShelfCount(tx, user, countId, input.code);
        else if (input.action === "setQty") await setShelfCountQty(tx, user, countId, input.variantId, input.qty);
        else if (input.action === "finish") result = await finishShelfCount(tx, user, countId, { request });
        else await cancelShelfCount(tx, user, countId);
      },
      { timeout: 60_000 },
    );
    return NextResponse.json({ scan, result, count: await getShelfCountView(prisma, user, countId) });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
