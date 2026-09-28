import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { createHubTransfer, getHubNeeds } from "@/lib/transfers/hub-needs";
import { stockDocumentErrorResponse } from "@/lib/transfers/http";

// C4 — CORRECTIONS.md item 3, "Needed at the packing hub". Reading it names
// orders and customers, so it's for the people who send stock; raising a
// transfer from it is checked against the person's locations and against
// the list as the server computes it now (lib/transfers/hub-needs.ts).

const querySchema = z.object({ locationId: z.string().trim().max(50).optional() });

const createSchema = z.object({
  fromLocationId: z.string().trim().min(1).max(50),
  note: z.string().trim().max(500).nullish(),
  picks: z
    .array(z.object({ orderId: z.string().trim().min(1).max(50), variantId: z.string().trim().min(1).max(50), qty: z.number().int().min(1).max(1_000) }))
    .min(1, "Tick at least one item")
    .max(500),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("transfer.send");
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  try {
    return NextResponse.json(await getHubNeeds(prisma, parsed.data.locationId || null));
  } catch (err) {
    const res = stockDocumentErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("transfer.send");
  if (!guard.ok) return guard.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  try {
    const transfer = await prisma.$transaction((tx) => createHubTransfer(tx, guard.user, parsed.data), { timeout: 30_000 });
    return NextResponse.json({ transfer }, { status: 201 });
  } catch (err) {
    const res = stockDocumentErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
