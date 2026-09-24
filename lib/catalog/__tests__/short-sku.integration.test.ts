import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { decodeCode128Widths } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { buildVariantSku, SKU_MAX_LENGTH } from "@/lib/catalog/codes";
import { findLabelStock, fitBarcode } from "@/lib/catalog/price-tag-layout";
import { lockSkusForPrintedTags, regenerateSkus, SkuError, skuForNewVariant } from "@/lib/catalog/sku";
import { findVariantByCode } from "@/lib/pos/lookup";
import { testProductCode } from "@/lib/test/catalog-codes";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// PRD §4.2 short SKUs: product + size + colour code, ≤ 9 characters, locked
// once a tag is printed. Rolled back on antu_test.

/** Runs `fn` expecting the database to refuse it, without aborting the test transaction. */
async function expectDbRefusal(tx: Prisma.TransactionClient, fn: () => Promise<unknown>, message: RegExp) {
  await tx.$executeRaw`SAVEPOINT refusal`;
  await expect(fn()).rejects.toThrow(message);
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT refusal`;
}

async function freshProductWithVariants(tx: Prisma.TransactionClient) {
  const [sizes, colors] = await Promise.all([tx.size.findMany({ take: 2, orderBy: { sortOrder: "asc" } }), tx.color.findMany({ take: 2, orderBy: { sortOrder: "asc" } })]);
  const code = testProductCode();
  const product = await tx.product.create({ data: { code, name: `SKU test ${code}`, basePrice: 1000 } });
  for (const size of sizes) {
    for (const color of colors) {
      await tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: await skuForNewVariant(tx, code, size.code, color.code) } });
    }
  }
  return { product, variants: await tx.productVariant.findMany({ where: { productId: product.id }, include: { size: true, color: true } }) };
}

describe("every SKU in the catalog", () => {
  it("is its codes joined, at most 9 characters, and scans reliably on the smallest label", async () => {
    await inRolledBackTransaction(async (tx) => {
      const variants = await tx.productVariant.findMany({ include: { product: true, size: true, color: true } });
      expect(variants.length).toBeGreaterThan(0);
      const smallest = findLabelStock("roll-38x25")!;
      for (const v of variants) {
        expect(v.sku).toBe(buildVariantSku(v.product.code, v.size.code, v.color.code));
        expect(v.sku.length).toBeLessThanOrEqual(SKU_MAX_LENGTH);
        const fit = fitBarcode(v.sku, smallest, 203);
        expect(fit, v.sku).toMatchObject({ quality: "ok", dots: 2 });
        // What the tag prints is what the POS scan finds.
        const scanned = decodeCode128Widths(code128Widths(v.sku));
        expect(scanned).toBe(v.sku);
        if (v.isActive) expect((await findVariantByCode(tx, scanned))?.variantId).toBe(v.id);
      }
    });
  }, 120_000);

  it("the database refuses a SKU over 9 characters, with symbols, or a code outside its length", async () => {
    await inRolledBackTransaction(async (tx) => {
      const v = await tx.productVariant.findFirstOrThrow({ where: { tagPrintedAt: null } });
      await expectDbRefusal(tx, () => tx.productVariant.update({ where: { id: v.id }, data: { sku: "K12XXLMYL1" } }), /product_variants_sku_chk/);
      await expectDbRefusal(tx, () => tx.productVariant.update({ where: { id: v.id }, data: { sku: "K12-M-MYL" } }), /product_variants_sku_chk/);
      const color = await tx.color.findFirstOrThrow();
      await expectDbRefusal(tx, () => tx.color.update({ where: { id: color.id }, data: { code: "MYLW" } }), /colors_code_chk/);
      const product = await tx.product.findFirstOrThrow();
      await expectDbRefusal(tx, () => tx.product.update({ where: { id: product.id }, data: { code: "KURTI12" } }), /products_code_chk/);
    });
  }, 60_000);
});

describe("codes rebuild SKUs until a tag is printed, then everything locks", () => {
  it("a colour-code change rebuilds unlocked SKUs; after a tag prints it's refused, and the DB won't let the SKU move", async () => {
    await inRolledBackTransaction(async (tx) => {
      const { product, variants } = await freshProductWithVariants(tx);
      const target = variants[0];

      // Before any tag: the product code changes and every SKU follows.
      const newCode = testProductCode();
      await tx.product.update({ where: { id: product.id }, data: { code: newCode } });
      const changes = await regenerateSkus(tx, { productId: product.id });
      expect(changes).toHaveLength(variants.length);
      const rebuilt = await tx.productVariant.findUniqueOrThrow({ where: { id: target.id } });
      expect(rebuilt.sku).toBe(buildVariantSku(newCode, target.size.code, target.color.code));

      // Printing a tag locks that variant, once.
      const locked = await lockSkusForPrintedTags(tx, [target.id]);
      expect(locked.map((l) => l.id)).toEqual([target.id]);
      expect(await lockSkusForPrintedTags(tx, [target.id])).toEqual([]);
      const after = await tx.productVariant.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.skuLocked).toBe(true);
      expect(after.tagPrintedAt).not.toBeNull();

      // Now a code behind it can't change, and the SKU itself can't move.
      await expect(regenerateSkus(tx, { productId: product.id })).rejects.toThrow(SkuError);
      await expectDbRefusal(tx, () => tx.productVariant.update({ where: { id: target.id }, data: { sku: "QQQMRN" } }), /locked/);
      await expectDbRefusal(tx, () => tx.productVariant.update({ where: { id: target.id }, data: { tagPrintedAt: null, skuLocked: false } }), /can't be cleared/);
      // Other columns still update as normal.
      await tx.productVariant.update({ where: { id: target.id }, data: { lowStockThreshold: 4 } });
    });
  }, 60_000);

  it("a new variant whose SKU is taken is refused before anything is written", async () => {
    await inRolledBackTransaction(async (tx) => {
      const existing = await tx.productVariant.findFirstOrThrow({ include: { product: true, size: true, color: true } });
      await expect(skuForNewVariant(tx, existing.product.code, existing.size.code, existing.color.code)).rejects.toThrow(/already used/);
    });
  }, 60_000);
});
