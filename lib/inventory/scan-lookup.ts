import type { Prisma } from "@prisma/client";

import { looksLikeBanglaKeyboard, normalizeScannedCode } from "@/lib/barcode/scan";
import type { Db } from "@/lib/db/tx";

// C4 — what every stock scan screen (transfer send/receive, stock count)
// does with a scanned or typed tag: turn it into exactly one variant, or
// refuse with a message a person at a counter can act on.

export class ScanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const scannedVariantSelect = {
  id: true,
  sku: true,
  size: { select: { name: true } },
  color: { select: { name: true, hexCode: true } },
  product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } },
} satisfies Prisma.ProductVariantSelect;

export type ScannedVariant = Prisma.ProductVariantGetPayload<{ select: typeof scannedVariantSelect }>;

export async function findVariantByScan(db: Db, raw: string): Promise<ScannedVariant> {
  if (looksLikeBanglaKeyboard(raw)) throw new ScanError("The keyboard is on Bangla — switch it to English and scan again.");
  const code = normalizeScannedCode(raw);
  if (!code) throw new ScanError(`“${raw.trim().slice(0, 30)}” isn't a tag code — a SKU is capital letters and digits.`);
  const variant = await db.productVariant.findFirst({ where: { sku: code, product: { deletedAt: null } }, select: scannedVariantSelect });
  if (!variant) throw new ScanError(`No item has the tag ${code}.`, 404);
  return variant;
}

/** One line's item, as every scan screen shows it. Never carries cost. */
export function scannedItem(v: ScannedVariant) {
  return {
    variantId: v.id,
    sku: v.sku,
    productName: v.product.name,
    sizeName: v.size.name,
    colorName: v.color.name,
    colorHex: v.color.hexCode,
    thumbPath: v.product.images[0]?.thumbPath ?? null,
  };
}
