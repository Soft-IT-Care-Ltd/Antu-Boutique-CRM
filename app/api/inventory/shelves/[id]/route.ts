import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { shelfErrorResponse } from "@/lib/shelves/http";
import { getShelfView, updateShelf } from "@/lib/shelves/service";

// C4b — one shelf: what's on it and its history (GET); its note, or
// switching it off once empty (PATCH, shelf.manage).

const patchSchema = z.object({ note: z.string().trim().max(200).nullish(), isActive: z.boolean().optional() }).refine((v) => v.note !== undefined || v.isActive !== undefined, "Nothing to change");

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["shelf.manage", "shelf.putaway", "stock.count", "inventory.adjust"]);
  if (!guard.ok) return guard.response;
  const shelf = await getShelfView(prisma, guard.user, (await params).id);
  if (!shelf) return NextResponse.json({ error: "Shelf not found" }, { status: 404 });
  return NextResponse.json({ shelf });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("shelf.manage");
  if (!guard.ok) return guard.response;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const { id } = await params;
  try {
    await prisma.$transaction((tx) => updateShelf(tx, guard.user, id, parsed.data, { request }));
    return NextResponse.json({ shelf: await getShelfView(prisma, guard.user, id) });
  } catch (err) {
    const res = shelfErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
