import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { shelfErrorResponse } from "@/lib/shelves/http";
import { identifyPutAwayScan, putAway } from "@/lib/shelves/service";

// C4b — put-away and moving by scan. "identify" reads one scan (a dress, or
// a shelf label) and changes nothing; "place" puts the scanned dresses on
// the scanned shelf, all or nothing. shelf.putaway + the location, checked
// in the service.

const id = z.string().trim().min(1).max(50);

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("identify"), locationId: id, code: z.string().min(1, "Scan or type a tag").max(60) }),
  z.object({
    action: z.literal("place"),
    locationId: id,
    toShelfId: id,
    fromShelfId: id.nullish(),
    items: z.array(z.object({ variantId: id, qty: z.number().int().min(1).max(10_000) })).min(1, "Scan the dresses first, then the shelf").max(500),
  }),
]);

export async function POST(request: NextRequest) {
  const guard = await requirePermission("shelf.putaway");
  if (!guard.ok) return guard.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const input = parsed.data;
  try {
    if (input.action === "identify") return NextResponse.json({ scan: await identifyPutAwayScan(prisma, guard.user, input.locationId, input.code) });
    const result = await prisma.$transaction((tx) => putAway(tx, guard.user, input), { timeout: 30_000 });
    return NextResponse.json({ result });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
