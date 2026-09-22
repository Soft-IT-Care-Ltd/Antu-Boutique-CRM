import "server-only";

import { prisma } from "@/lib/prisma";

// PRD §4.2 — variant SKU is auto-generated as PRD-<code>-<SIZE>-<COLOR>,
// unique, editable once. <code> is the product's own short code (also
// auto-generated, editable any time from the product form).

function slugToken(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** Auto-suggests the next unique product code (e.g. "KURTI", "KURTI2"). Retries on collision. */
export async function generateProductCode(name: string): Promise<string> {
  const base = slugToken(name).slice(0, 10) || "PRD";
  let candidate = base;
  let attempt = 1;

  while (await prisma.product.findUnique({ where: { code: candidate }, select: { id: true } })) {
    attempt += 1;
    candidate = `${base}${attempt}`;
  }

  return candidate;
}

export function buildVariantSku(productCode: string, sizeName: string, colorName: string): string {
  return `PRD-${slugToken(productCode)}-${slugToken(sizeName)}-${slugToken(colorName)}`;
}

/** Appends -2, -3, ... if the generated SKU collides (e.g. two colours that slug to the same token). */
export async function generateUniqueVariantSku(
  productCode: string,
  sizeName: string,
  colorName: string,
): Promise<string> {
  const base = buildVariantSku(productCode, sizeName, colorName);
  let candidate = base;
  let attempt = 1;

  while (await prisma.productVariant.findUnique({ where: { sku: candidate }, select: { id: true } })) {
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }

  return candidate;
}
