import "server-only";

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { buildVariantSku, SKU_MAX_LENGTH, suggestColorCode, suggestProductCode, suggestSizeCode } from "@/lib/catalog/codes";
import { SKU_PATTERN } from "@/lib/barcode/scan";

// PRD §4.2 — SKU = product code + size code + colour code (lib/catalog/codes.ts),
// at most 9 characters. A variant's SKU is regenerated whenever a code it's
// built from changes — until its first price tag is printed. From then on it
// is locked (tagPrintedAt; a DB trigger refuses any change), and the codes
// behind it can't change either.

export class SkuError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

async function taken(db: Db, model: "product" | "color" | "size"): Promise<Set<string>> {
  const rows =
    model === "product"
      ? await db.product.findMany({ select: { code: true } })
      : model === "color"
        ? await db.color.findMany({ select: { code: true } })
        : await db.size.findMany({ select: { code: true } });
  return new Set(rows.map((r) => r.code));
}

export async function generateProductCode(db: Db, name: string): Promise<string> {
  const code = suggestProductCode(name, await taken(db, "product"));
  if (!code) throw new SkuError("Couldn't suggest a free product code — type one in.", 400);
  return code;
}

export async function generateColorCode(db: Db, name: string): Promise<string> {
  const code = suggestColorCode(name, await taken(db, "color"));
  if (!code) throw new SkuError("Couldn't suggest a free colour code — type one in.", 400);
  return code;
}

export async function generateSizeCode(db: Db, name: string): Promise<string> {
  const code = suggestSizeCode(name, await taken(db, "size"));
  if (!code) throw new SkuError("Couldn't suggest a free size code — type one in.", 400);
  return code;
}

/** The SKU for a new variant, refused if it's over the cap or another variant already has it. */
export async function skuForNewVariant(db: Db, productCode: string, sizeCode: string, colorCode: string): Promise<string> {
  const sku = buildVariantSku(productCode, sizeCode, colorCode);
  assertSkuShape(sku);
  const clash = await db.productVariant.findUnique({ where: { sku }, select: { product: { select: { name: true } } } });
  if (clash) throw new SkuError(`SKU ${sku} is already used by ${clash.product.name} — change this product's or the colour's code.`);
  return sku;
}

export function assertSkuShape(sku: string): void {
  if (sku.length > SKU_MAX_LENGTH) throw new SkuError(`SKU ${sku} is ${sku.length} characters — at most ${SKU_MAX_LENGTH} scan reliably on a 38 mm tag. Shorten the codes.`, 400);
  if (!SKU_PATTERN.test(sku)) throw new SkuError(`SKU ${sku} may only use capital letters and digits.`, 400);
}

/** Variants whose SKU is already on a printed tag — a code behind them can't change. */
export async function countLockedVariants(db: Db, where: Prisma.ProductVariantWhereInput): Promise<number> {
  return db.productVariant.count({ where: { ...where, tagPrintedAt: { not: null } } });
}

/**
 * Rebuilds the SKU of every variant matching `where` from its current codes
 * (after a product/size/colour code changed). Refuses — before writing
 * anything — if one of them is locked, too long, or would collide.
 * Returns [old, new] pairs for the audit log.
 */
export async function regenerateSkus(tx: Prisma.TransactionClient, where: Prisma.ProductVariantWhereInput): Promise<[string, string][]> {
  const rows = await tx.productVariant.findMany({
    where,
    select: { id: true, sku: true, tagPrintedAt: true, product: { select: { code: true } }, size: { select: { code: true } }, color: { select: { code: true } } },
  });
  const locked = rows.filter((r) => r.tagPrintedAt);
  if (locked.length > 0) {
    throw new SkuError(`Tags are already printed for ${locked.length} variant${locked.length === 1 ? "" : "s"} (${locked.slice(0, 3).map((r) => r.sku).join(", ")}${locked.length > 3 ? "…" : ""}) — their SKUs are locked, so this code can't change.`);
  }
  const next = rows.map((r) => ({ id: r.id, old: r.sku, sku: buildVariantSku(r.product.code, r.size.code, r.color.code) })).filter((r) => r.sku !== r.old);
  for (const r of next) assertSkuShape(r.sku);
  const ids = new Set(rows.map((r) => r.id));
  const clashes = await tx.productVariant.findMany({ where: { sku: { in: next.map((r) => r.sku) } }, select: { id: true, sku: true } });
  const clash = clashes.find((c) => !ids.has(c.id));
  if (clash) throw new SkuError(`SKU ${clash.sku} is already used by another variant — pick a different code.`);
  for (const r of next) await tx.productVariant.update({ where: { id: r.id }, data: { sku: r.sku } });
  return next.map((r) => [r.old, r.sku]);
}

/**
 * P3.1 — a variant's SKU locks the first time a tag is printed for it.
 * Returns the SKUs that were locked just now (already-locked ones are left alone).
 */
export async function lockSkusForPrintedTags(tx: Prisma.TransactionClient, variantIds: string[]): Promise<{ id: string; sku: string; productId: string }[]> {
  const fresh = await tx.productVariant.findMany({ where: { id: { in: variantIds }, tagPrintedAt: null }, select: { id: true, sku: true, productId: true } });
  if (fresh.length === 0) return [];
  await tx.productVariant.updateMany({ where: { id: { in: fresh.map((v) => v.id) }, tagPrintedAt: null }, data: { tagPrintedAt: new Date(), skuLocked: true } });
  return fresh;
}
