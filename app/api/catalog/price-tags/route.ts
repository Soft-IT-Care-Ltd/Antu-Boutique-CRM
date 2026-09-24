import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { lockSkusForPrintedTags } from "@/lib/catalog/sku";
import { findLabelStock, LABEL_STOCKS, ROLL_PRINTER_DPIS, stockDpi } from "@/lib/catalog/price-tag-layout";
import { expandTags, PriceTagError, renderPriceTagsPdf } from "@/lib/catalog/price-tags";
import { badRequest, idString } from "@/lib/finance/http";
import { todayInDhaka } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// P3.1 — price tags as a PDF: one label per page at the label's exact size
// (label printer), or a grid on an A4 sticker sheet. Posted as a normal form
// (field `payload`, JSON) by the tag screen so the PDF opens in a new tab on
// every browser, iPad Safari included, without a pop-up blocker in the way;
// a JSON body works too. The PDF isn't stored; printing locks each tagged
// variant's SKU (PRD §4.2).

const requestSchema = z.object({
  items: z
    .array(z.object({ variantId: idString, copies: z.coerce.number().int().min(0).max(500) }))
    .min(1, "Pick at least one tag to print")
    .max(500),
  stockId: z.enum(LABEL_STOCKS.map((s) => s.id) as [string, ...string[]]),
  dpi: z.coerce.number().refine((d) => (ROLL_PRINTER_DPIS as readonly number[]).includes(d), "Pick 203 or 300 dpi").default(203),
  startAt: z.coerce.number().int().min(1).max(40).default(1),
});

async function readBody(request: NextRequest): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return request.json().catch(() => null);
  const form = await request.formData().catch(() => null);
  const payload = form?.get("payload");
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("product.tags.print");
  if (!guard.ok) return guard.response;
  const parsed = requestSchema.safeParse(await readBody(request));
  if (!parsed.success) return badRequest(parsed.error);

  const stock = findLabelStock(parsed.data.stockId)!;
  const dpi = stockDpi(stock, parsed.data.dpi as (typeof ROLL_PRINTER_DPIS)[number]);
  try {
    const tags = await expandTags(prisma, { items: parsed.data.items, stock, dpi, startAt: parsed.data.startAt });
    const pdf = await renderPriceTagsPdf(tags, stock, dpi, parsed.data.startAt);

    // PRD §4.2: a SKU locks the first time its tag is printed — from now on
    // a physical tag carries it. Audited per product.
    const locked = await prisma.$transaction((tx) => lockSkusForPrintedTags(tx, parsed.data.items.filter((i) => i.copies > 0).map((i) => i.variantId)));
    const byProduct = new Map<string, string[]>();
    for (const v of locked) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v.sku]);
    for (const [productId, skus] of byProduct) {
      await writeAuditLog({ actorId: guard.user.id, action: "catalog.variant.sku_lock", entityType: "product", entityId: productId, after: { lockedSkus: skus, reason: "price tag printed" }, request });
    }

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="price-tags-${todayInDhaka()}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof PriceTagError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
