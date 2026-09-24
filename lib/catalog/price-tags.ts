import "server-only";

import type { Prisma } from "@prisma/client";

import { isBarcodeSafeSku } from "@/lib/barcode/scan";
import type { Db } from "@/lib/db/tx";
import { A4, fitBarcode, placeTags, renderTagHtml, TAG_CSS, type LabelStock, type TagData } from "@/lib/catalog/price-tag-layout";
import { getFontFaceCss, renderHtmlToPdf } from "@/lib/pdf/render";

// P3.1 price tags: which tags to print (by variant, a whole product, or
// everything a purchase received), and the PDF — one label per page at the
// label's size for a label printer, or a grid on A4 sticker sheets.
// Tags carry the selling price only; nothing here reads cost.

export class PriceTagError extends Error {}

/** Most tags one PDF will hold — a whole purchase fits; a runaway request doesn't. */
export const MAX_TAGS_PER_PRINT = 2000;

export type TagSourceItem = TagData & {
  variantId: string;
  productId: string;
  onHand: number;
  /** Suggested number of tags: units received (purchase) or on hand (product). */
  suggestedCopies: number;
  barcodeSafe: boolean;
  /** A tag was printed before: the SKU can't change any more. */
  locked: boolean;
};

const variantSelect = {
  id: true,
  sku: true,
  stockQty: true,
  priceOverride: true,
  tagPrintedAt: true,
  size: { select: { name: true } },
  color: { select: { name: true } },
  product: { select: { id: true, name: true, basePrice: true } },
} satisfies Prisma.ProductVariantSelect;

type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

function toItem(v: VariantRow, suggestedCopies: number): TagSourceItem {
  return {
    variantId: v.id,
    productId: v.product.id,
    sku: v.sku,
    productName: v.product.name,
    sizeName: v.size.name,
    colorName: v.color.name,
    price: (v.priceOverride ?? v.product.basePrice).toFixed(2),
    onHand: v.stockQty,
    suggestedCopies,
    barcodeSafe: isBarcodeSafeSku(v.sku),
    locked: v.tagPrintedAt !== null,
  };
}

const variantOrder = [{ product: { name: "asc" } }, { size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }] satisfies Prisma.ProductVariantOrderByWithRelationInput[];

/** Every active size/colour of a product, one tag per unit on hand by default. */
export async function tagsForProduct(db: Db, productId: string): Promise<TagSourceItem[]> {
  const rows = await db.productVariant.findMany({ where: { productId, isActive: true, product: { deletedAt: null } }, select: variantSelect, orderBy: variantOrder });
  return rows.map((v) => toItem(v, Math.max(0, v.stockQty)));
}

/** Everything a purchase received, one tag per unit received. */
export async function tagsForPurchase(db: Db, purchaseId: string): Promise<TagSourceItem[] | null> {
  const purchase = await db.purchase.findUnique({
    where: { id: purchaseId },
    select: { items: { select: { qty: true, variant: { select: variantSelect } }, orderBy: { createdAt: "asc" } } },
  });
  if (!purchase) return null;
  const qtyByVariant = new Map<string, { row: VariantRow; qty: number }>();
  for (const item of purchase.items) {
    const entry = qtyByVariant.get(item.variant.id) ?? { row: item.variant, qty: 0 };
    entry.qty += item.qty;
    qtyByVariant.set(item.variant.id, entry);
  }
  return [...qtyByVariant.values()].map(({ row, qty }) => toItem(row, qty));
}

/** Type-ahead for adding single variants: name, code or SKU. */
export async function searchTagVariants(db: Db, q: string): Promise<TagSourceItem[]> {
  const rows = await db.productVariant.findMany({
    where: {
      isActive: true,
      product: { deletedAt: null },
      OR: [{ sku: { contains: q, mode: "insensitive" } }, { product: { name: { contains: q, mode: "insensitive" } } }, { product: { code: { contains: q, mode: "insensitive" } } }],
    },
    select: variantSelect,
    orderBy: variantOrder,
    take: 30,
  });
  return rows.map((v) => toItem(v, 1));
}

/** Recent purchases to print from — dates, supplier and units only, no money. */
export async function recentPurchasesForTags(db: Db) {
  const rows = await db.purchase.findMany({
    orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }],
    take: 30,
    select: { id: true, purchaseDate: true, invoiceNo: true, supplier: { select: { name: true } }, items: { select: { qty: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    purchaseDate: p.purchaseDate.toISOString(),
    invoiceNo: p.invoiceNo,
    supplierName: p.supplier.name,
    lines: p.items.length,
    units: p.items.reduce((a, i) => a + i.qty, 0),
  }));
}

export type TagPrintRequest = { items: { variantId: string; copies: number }[]; stock: LabelStock; dpi: number; startAt: number };

/** Expands the request into one TagData per physical tag, refusing any SKU a barcode can't carry here. */
export async function expandTags(db: Db, request: TagPrintRequest): Promise<TagData[]> {
  const wanted = request.items.filter((i) => i.copies > 0);
  const total = wanted.reduce((a, i) => a + i.copies, 0);
  if (total === 0) throw new PriceTagError("Pick at least one tag to print.");
  if (total > MAX_TAGS_PER_PRINT) throw new PriceTagError(`That's ${total} tags — print at most ${MAX_TAGS_PER_PRINT} at a time.`);

  const rows = await db.productVariant.findMany({ where: { id: { in: [...new Set(wanted.map((i) => i.variantId))] } }, select: variantSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tags: TagData[] = [];
  for (const item of wanted) {
    const row = byId.get(item.variantId);
    if (!row) throw new PriceTagError("One of the items is no longer in the catalog — remove it and try again.");
    const tag = toItem(row, item.copies);
    if (!tag.barcodeSafe) throw new PriceTagError(`${tag.sku} can't be printed as a barcode — edit the SKU to capital letters, digits and hyphens first.`);
    if (fitBarcode(tag.sku, request.stock, request.dpi).quality === "too-long") {
      throw new PriceTagError(`${tag.sku} is too long for a ${request.stock.width} mm label — pick a wider label or an A4 sheet.`);
    }
    for (let n = 0; n < item.copies; n += 1) tags.push(tag);
  }
  return tags;
}

export async function renderPriceTagsPdf(tags: TagData[], stock: LabelStock, dpi: number, startAt: number): Promise<Uint8Array> {
  const { placed, pages } = placeTags(tags, stock, startAt);
  const pageW = stock.kind === "ROLL" ? stock.width : A4.width;
  const pageH = stock.kind === "ROLL" ? stock.height : A4.height;

  const pageHtml = Array.from({ length: pages }, (_, page) => {
    const tagsHtml = placed
      .filter((p) => p.page === page)
      .map((p) => `<div class="tag" style="left:${p.x}mm;top:${p.y}mm;width:${stock.width}mm;height:${stock.height}mm">${renderTagHtml(p.tag, stock, dpi, { x: p.x, y: p.y })}</div>`)
      .join("");
    return `<section class="page">${tagsHtml}</section>`;
  }).join("");

  const html = `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<style>
  ${await getFontFaceCss()}
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  .page { position: relative; width: ${pageW}mm; height: ${pageH}mm; overflow: hidden; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  ${TAG_CSS}
</style>
</head>
<body>${pageHtml}</body>
</html>`;
  return renderHtmlToPdf(html, { widthMm: pageW, heightMm: pageH });
}
