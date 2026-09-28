import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { decodeCode128Widths } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { buildVariantSku, PRODUCT_CODE_PATTERN, SKU_MAX_LENGTH } from "@/lib/catalog/codes";
import { findLabelStock, fitBarcode } from "@/lib/catalog/price-tag-layout";
import { generateVariants, lockSkusForPrintedTags, regenerateSkus, SkuError, skuForNewVariant } from "@/lib/catalog/sku";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
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
        // Packaging material (P3.3) is never sold, so the POS scan doesn't find it.
        if (v.isActive && v.product.kind === "SELLABLE") expect((await findVariantByCode(tx, scanned, SEEDED_LOCATION_IDS.shyamoli))?.variantId).toBe(v.id);
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

// No separators, so different codes can join into one SKU. Numeric sizes make
// it real: K1 + 23 + MRN and K12 + 3 + MRN are both K123MRN.
describe("SKUs that join the same way from different codes", () => {
  async function sizeWithCode(tx: Prisma.TransactionClient, code: string) {
    return (await tx.size.findUnique({ where: { code } })) ?? tx.size.create({ data: { name: `Test size ${code}`, code, sortOrder: 90 } });
  }
  async function colorWithCode(tx: Prisma.TransactionClient, code: string) {
    return (await tx.color.findUnique({ where: { code } })) ?? tx.color.create({ data: { name: `Test colour ${code}`, code, hexCode: "#123456", sortOrder: 90 } });
  }
  const actor = null;

  it("K1 + 23 + MRN vs K12 + 3 + MRN: the clash is caught before saving and K1 moves to the next free code", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [size3, size23, maroon] = await Promise.all([sizeWithCode(tx, "3"), sizeWithCode(tx, "23"), colorWithCode(tx, "MRN")]);
      const k12 = (await tx.product.findUnique({ where: { code: "K12" } })) ?? (await tx.product.create({ data: { code: "K12", name: "Kurti 12", basePrice: 1450 } }));
      expect(await tx.product.findUnique({ where: { code: "K1" } })).toBeNull();

      const first = await generateVariants(tx, { productId: k12.id, sizes: [size3], colors: [maroon], actorId: actor });
      expect(first).toEqual({ created: ["K123MRN"], codeChange: null, notice: null });

      const k1 = await tx.product.create({ data: { code: "K1", name: "Kurti 1", basePrice: 1200 } });
      expect(buildVariantSku("K1", size23.code, maroon.code)).toBe("K123MRN"); // the collision, spelled out

      const second = await generateVariants(tx, { productId: k1.id, sizes: [size23], colors: [maroon], actorId: actor });
      const moved = second.codeChange!.to;
      expect(second.codeChange?.from).toBe("K1");
      expect(moved).toMatch(PRODUCT_CODE_PATTERN);
      expect(["K1", "K12"]).not.toContain(moved);
      expect(second.created).toEqual([buildVariantSku(moved, "23", "MRN")]);
      expect(second.notice).toContain(`SKU K123MRN is already used by ${k12.name} (K12 · size ${size3.name} · ${maroon.name})`);
      expect(second.notice).toContain(`from K1 to ${moved}`);

      // Saved: K1 is now the new code, both variants exist, every SKU once.
      expect((await tx.product.findUniqueOrThrow({ where: { id: k1.id } })).code).toBe(moved);
      expect((await tx.productVariant.findUniqueOrThrow({ where: { sku: "K123MRN" } })).productId).toBe(k12.id);
      expect((await tx.productVariant.findUniqueOrThrow({ where: { sku: second.created[0] } })).productId).toBe(k1.id);
      const all = await tx.productVariant.findMany({ select: { sku: true } });
      expect(new Set(all.map((v) => v.sku)).size).toBe(all.length);
      const audit = await tx.auditLog.findFirst({ where: { entityId: k1.id, action: "catalog.product.code_auto_change" } });
      expect(audit?.before).toEqual({ code: "K1" });
    });
  }, 60_000);

  it("the other way round, when the product's tags are printed: refused with a sentence, nothing written", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [size3, size23, maroon, black] = await Promise.all([sizeWithCode(tx, "3"), sizeWithCode(tx, "23"), colorWithCode(tx, "MRN"), colorWithCode(tx, "BLK")]);
      // Q1 / Q12: the same shape as K1 / K12, never used by seed or fixtures.
      const q1 = await tx.product.create({ data: { code: "Q1", name: "Test Q1", basePrice: 900 } });
      const q12 = await tx.product.create({ data: { code: "Q12", name: "Test Q12", basePrice: 900 } });
      await generateVariants(tx, { productId: q1.id, sizes: [size23], colors: [maroon], actorId: actor });
      await generateVariants(tx, { productId: q12.id, sizes: [size3], colors: [black], actorId: actor });
      const printed = await tx.productVariant.findFirstOrThrow({ where: { productId: q12.id } });
      await lockSkusForPrintedTags(tx, [printed.id]);

      const error = await generateVariants(tx, { productId: q12.id, sizes: [size3], colors: [maroon], actorId: actor }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SkuError);
      expect((error as SkuError).message).toMatch(/SKU Q123MRN is already used by Test Q1 .*tags are already printed/);
      expect((await tx.product.findUniqueOrThrow({ where: { id: q12.id } })).code).toBe("Q12");
      expect(await tx.productVariant.count({ where: { productId: q12.id } })).toBe(1);
    });
  }, 60_000);

  it("two size/colour pairs of one product that read the same are refused before anything is written", async () => {
    await inRolledBackTransaction(async (tx) => {
      // Size X + LRD and size XL + RD both end …XLRD.
      const [x, xl, lrd, rd] = await Promise.all([sizeWithCode(tx, "X"), sizeWithCode(tx, "XL"), colorWithCode(tx, "LRD"), colorWithCode(tx, "RD")]);
      const code = testProductCode();
      const product = await tx.product.create({ data: { code, name: `SKU test ${code}`, basePrice: 1000 } });
      await expect(generateVariants(tx, { productId: product.id, sizes: [x, xl], colors: [lrd, rd], actorId: actor })).rejects.toThrow(
        new RegExp(`would both be SKU ${code}XLRD`),
      );
      expect(await tx.productVariant.count({ where: { productId: product.id } })).toBe(0);
    });
  }, 60_000);

  it("the database itself refuses a duplicate SKU", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [taken, other] = await tx.productVariant.findMany({ take: 2, orderBy: { sku: "asc" } });
      await expectDbRefusal(tx, () => tx.productVariant.update({ where: { id: other.id }, data: { sku: taken.sku } }), /sku/);
    });
  }, 60_000);
});
