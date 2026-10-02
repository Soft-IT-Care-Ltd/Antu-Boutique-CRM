import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { shelfErrorResponse } from "@/lib/shelves/http";
import { generateShelfCodes } from "@/lib/shelves/constants";
import { createShelves, getShelfLocationView } from "@/lib/shelves/service";

// C4b — CORRECTIONS.md item 20A. A location's shelves (GET), and adding
// shelves (POST, shelf.manage — checked in the service with the location).

const id = z.string().trim().min(1).max(50);

const createSchema = z.union([
  z.object({ locationId: id, codes: z.array(z.string().trim().min(1).max(20)).min(1, "Give at least one shelf code").max(200), note: z.string().trim().max(200).nullish() }),
  z.object({
    locationId: id,
    // A whole rack at once: A, 4 shelves, 3 boxes each → A-1-1 … A-4-3.
    rack: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "A rack is 1–4 letters or digits, like A"),
    shelves: z.number().int().min(1, "At least one shelf").max(20),
    boxes: z.number().int().min(0).max(20),
    note: z.string().trim().max(200).nullish(),
  }),
]);

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["shelf.manage", "shelf.putaway", "stock.count", "inventory.adjust"]);
  if (!guard.ok) return guard.response;
  const parsed = id.safeParse(request.nextUrl.searchParams.get("locationId"));
  if (!parsed.success) return NextResponse.json({ error: "Pick a location" }, { status: 400 });
  try {
    return NextResponse.json({ view: await getShelfLocationView(prisma, guard.user, parsed.data) });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("shelf.manage");
  if (!guard.ok) return guard.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const input = parsed.data;
  const codes = "codes" in input ? input.codes : generateShelfCodes(input.rack, input.shelves, input.boxes);
  if (codes.length > 200) return NextResponse.json({ error: "At most 200 shelves at a time" }, { status: 400 });
  try {
    const result = await prisma.$transaction((tx) => createShelves(tx, guard.user, { locationId: input.locationId, codes, note: input.note }, { request }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
