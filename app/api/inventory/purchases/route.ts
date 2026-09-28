import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { createPurchase, PurchaseError } from "@/lib/inventory/purchases";
import { PURCHASE_VIEW_PERMISSIONS, getPurchaseDetail, listPurchases } from "@/lib/inventory/queries";
import { paginationQuery } from "@/lib/list/pagination";
import { assertCanActAt, getPackingHub, LocationError } from "@/lib/locations/service";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");
// Money is rounded to the paisa by lib/inventory/costing.ts's toPaisa.
const money = z.coerce.number({ error: "Enter an amount" }).min(0, "Amounts can't be negative").max(100_000_000, "Amount is too large");

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: z.string().trim().max(50).optional(),
  due: z.enum(["true", "false"]).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  ...paginationQuery,
});

const createSchema = z.object({
  supplierId: z.string().trim().min(1, "Pick a supplier"),
  purchaseDate: dateString,
  invoiceNo: z.string().trim().max(60).nullish(),
  allocationMethod: z.enum(["BY_VALUE", "BY_QTY"]).default("BY_VALUE"),
  transportCost: money.default(0),
  otherCost: money.default(0),
  amountPaid: money.default(0),
  note: z.string().trim().max(1000).nullish(),
  items: z
    .array(
      z.object({
        variantId: z.string().trim().min(1),
        // C3 (CORRECTIONS.md item 4): where the line is received. Blank =
        // the packing hub.
        locationId: z.string().trim().max(50).nullish(),
        qty: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(100_000),
        unitCost: money,
      }),
    )
    .min(1, "Add at least one item")
    .max(200),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(PURCHASE_VIEW_PERMISSIONS, "all");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { q, supplierId, due, from, to, page, pageSize } = parsed.data;

  const result = await listPurchases({
    q: q || undefined,
    supplierId: supplierId || undefined,
    dueOnly: due === "true",
    from: from ? dhakaDayStartUtc(from) : undefined,
    to: to ? dhakaDayStartUtc(to, 1) : undefined,
    page,
    pageSize,
  });
  // Belt and braces: the guard already requires product.cost.view.
  return NextResponse.json(await stripCostFieldsForUser({ ...result, page, pageSize }, guard.user));
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission(PURCHASE_VIEW_PERMISSIONS, "all");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const input = parsed.data;

  try {
    // Each line's location: the packing hub by default, and only one the
    // buyer acts for (location managers receive into their own locations).
    const hub = await getPackingHub(prisma);
    const items = input.items.map((i) => ({ ...i, locationId: i.locationId || hub.id }));
    for (const locationId of new Set(items.map((i) => i.locationId))) await assertCanActAt(prisma, guard.user, locationId);

    const purchase = await prisma.$transaction(
      (tx) =>
        createPurchase(
          tx,
          {
            ...input,
            items,
            // Purchase date is a Dhaka calendar day; store its midnight in UTC.
            purchaseDate: dhakaDayStartUtc(input.purchaseDate),
          },
          guard.user.id,
        ),
      { timeout: 30_000 },
    );

    const detail = await getPurchaseDetail(purchase.id);
    await writeAuditLog({
      actorId: guard.user.id,
      action: "purchase.create",
      entityType: "purchase",
      entityId: purchase.id,
      after: detail,
      request,
    });

    return NextResponse.json({ purchase: detail }, { status: 201 });
  } catch (err) {
    if (err instanceof PurchaseError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof LocationError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "This supplier invoice number has already been entered" }, { status: 409 });
    }
    throw err;
  }
}
