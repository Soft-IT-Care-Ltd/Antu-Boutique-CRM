import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { findLabelStock, LABEL_STOCKS, ROLL_PRINTER_DPIS, stockDpi } from "@/lib/catalog/price-tag-layout";
import { badRequest, idString } from "@/lib/finance/http";
import { todayInDhaka } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";
import { renderShelfLabelsPdf, shelfLabelsFor, ShelfLabelError } from "@/lib/shelves/labels";

// C4b — shelf labels as a PDF, on the price tags' label sizes. Posted as a
// normal form (field `payload`, JSON) so the PDF opens in a new tab on every
// browser, iPad Safari included — same as the price tags.

const requestSchema = z.object({
  shelfIds: z.array(idString).min(1, "Pick at least one shelf").max(500),
  copies: z.coerce.number().int().min(1).max(10).default(1),
  stockId: z.enum(LABEL_STOCKS.map((s) => s.id) as [string, ...string[]]),
  dpi: z.coerce.number().refine((d) => (ROLL_PRINTER_DPIS as readonly number[]).includes(d), "Pick 203 or 300 dpi").default(203),
  startAt: z.coerce.number().int().min(1).max(40).default(1),
});

async function readBody(request: NextRequest): Promise<unknown> {
  if ((request.headers.get("content-type") ?? "").includes("application/json")) return request.json().catch(() => null);
  const payload = (await request.formData().catch(() => null))?.get("payload");
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("shelf.manage");
  if (!guard.ok) return guard.response;
  const parsed = requestSchema.safeParse(await readBody(request));
  if (!parsed.success) return badRequest(parsed.error);
  const stock = findLabelStock(parsed.data.stockId)!;
  const dpi = stockDpi(stock, parsed.data.dpi as (typeof ROLL_PRINTER_DPIS)[number]);
  try {
    const labels = await shelfLabelsFor(prisma, parsed.data.shelfIds, parsed.data.copies);
    const pdf = await renderShelfLabelsPdf(labels, stock, dpi, parsed.data.startAt);
    return new NextResponse(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="shelf-labels-${todayInDhaka()}.pdf"`, "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ShelfLabelError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
