import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { paginationQuery } from "@/lib/list/pagination";
import { prisma } from "@/lib/prisma";
import { TRANSFER_TABS, TRANSFER_VIEW_PERMISSIONS } from "@/lib/transfers/constants";
import { stockDocumentErrorResponse } from "@/lib/transfers/http";
import { createTransfer, listTransfers } from "@/lib/transfers/service";

// C4 — CORRECTIONS.md item 3. Listing is scoped server-side to transfers
// from or to the person's own locations (location.all: every one).

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");

const querySchema = z.object({
  tab: z.enum(TRANSFER_TABS).default("open"),
  locationId: z.string().trim().max(50).optional(),
  q: z.string().trim().max(60).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  ...paginationQuery,
});

const createSchema = z.object({
  fromLocationId: z.string().trim().min(1, "Pick where it's sent from").max(50),
  toLocationId: z.string().trim().min(1, "Pick where it's going").max(50),
  note: z.string().trim().max(500).nullish(),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(TRANSFER_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const { from, to, q, locationId, ...rest } = parsed.data;
  const result = await listTransfers(prisma, guard.user, {
    ...rest,
    q: q || undefined,
    locationId: locationId || undefined,
    from: from ? dhakaDayStartUtc(from) : undefined,
    to: to ? dhakaDayStartUtc(to, 1) : undefined,
  });
  return NextResponse.json({ ...result, page: rest.page, pageSize: rest.pageSize });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("transfer.send");
  if (!guard.ok) return guard.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  try {
    const transfer = await prisma.$transaction((tx) => createTransfer(tx, guard.user, parsed.data));
    return NextResponse.json({ transfer }, { status: 201 });
  } catch (err) {
    const res = stockDocumentErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
