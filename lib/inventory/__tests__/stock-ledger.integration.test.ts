import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { adjustStock, writeOffDamagedStock } from "@/lib/inventory/adjustments";
import { WRITE_OFF_EXPENSE_CATEGORY } from "@/lib/inventory/constants";
import { findStockLedgerDivergences, recordStockMovement, StockMovementError } from "@/lib/inventory/ledger";
import { createPurchase, PurchaseError } from "@/lib/inventory/purchases";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { packOrder } from "@/lib/orders/pack";
import { reserveVariantStock } from "@/lib/orders/stock";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// CLAUDE.md rule 2 / PRD §6 invariant 2: a stock change and its
// stock_movements row are written in one transaction, so
// sum(stock_movements.qty) per variant must always equal stock_qty.
//
// Requires `npm run db:seed` against DATABASE_URL (for sizes/colours/users/
// a customer). Everything that writes runs inside inRolledBackTransaction,
// so the shared database is left untouched.

const TIMEOUT = 120_000;

async function ledgerSum(tx: Prisma.TransactionClient, variantId: string): Promise<number> {
  const agg = await tx.stockMovement.aggregate({ where: { variantId }, _sum: { qty: true } });
  return agg._sum.qty ?? 0;
}

/** The invariant, checked two ways: directly, and by firing the DB's own commit-time trigger. */
async function expectStockMatchesLedger(tx: Prisma.TransactionClient, variantId: string) {
  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  expect(await ledgerSum(tx, variantId)).toBe(variant.stockQty);
  await checkDeferredConstraintsNow(tx);
  return variant;
}

async function makeScratchVariant(tx: Prisma.TransactionClient, tag: string) {
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow({}), tx.color.findFirstOrThrow({})]);
  const product = await tx.product.create({
    data: { code: `TST${tag}${Date.now()}`, name: `Ledger test ${tag}`, basePrice: 1000 },
  });
  return tx.productVariant.create({
    data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: `TST-${tag}-${Date.now()}` },
  });
}

async function fixtures(tx: Prisma.TransactionClient) {
  const [admin, packer, customer] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { phone: "01711000001" } }),
    tx.user.findUniqueOrThrow({ where: { phone: "01711000005" } }),
    tx.customer.findFirstOrThrow({}),
  ]);
  const supplier = await tx.supplier.create({ data: { name: `Test supplier ${Date.now()}` } });
  return { admin, packer, customer, supplier };
}

async function confirmedOrder(tx: Prisma.TransactionClient, customerId: string, variantId: string, qty: number) {
  const order = await tx.order.create({
    data: {
      orderNo: `TEST-LEDGER-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      status: "CONFIRMED",
      customerId,
      items: { create: [{ variantId, qty, unitPrice: 1000 }] },
    },
    include: { items: true },
  });
  await reserveVariantStock(tx, variantId, qty);
  return order;
}

describe("stock and ledger can never diverge (CLAUDE.md rule 2)", () => {
  it(
    "holds for every variant currently in the database",
    async () => {
      expect(await findStockLedgerDivergences(prisma)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "holds after a purchase, a sale (pack), a cancel-after-pack, an adjustment and a write-off — with WAC and costs right",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, packer, customer, supplier } = await fixtures(tx);
        const variant = await makeScratchVariant(tx, "A");
        await expectStockMatchesLedger(tx, variant.id);

        // 1. Purchase 10 @ ৳100 + ৳50 transport → landed ৳105; nothing on hand, so WAC = 105.
        const p1 = await createPurchase(
          tx,
          {
            supplierId: supplier.id,
            purchaseDate: new Date(),
            invoiceNo: "INV-1",
            allocationMethod: "BY_VALUE",
            transportCost: 50,
            otherCost: 0,
            amountPaid: 500,
            items: [{ variantId: variant.id, qty: 10, unitCost: 100 }],
          },
          admin.id,
        );
        expect(p1.totalCost.toString()).toBe("1050");
        expect(p1.dueAmount.toString()).toBe("550");
        let v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(10);
        expect(v.weightedAvgCost.toString()).toBe("105");

        // 2. Purchase 5 @ ৳130 → WAC = (10 × 105 + 5 × 130) ÷ 15 = 113.33.
        await createPurchase(
          tx,
          {
            supplierId: supplier.id,
            purchaseDate: new Date(),
            invoiceNo: "INV-2",
            allocationMethod: "BY_VALUE",
            transportCost: 0,
            otherCost: 0,
            amountPaid: 0,
            items: [{ variantId: variant.id, qty: 5, unitCost: 130 }],
          },
          admin.id,
        );
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(15);
        expect(v.weightedAvgCost.toString()).toBe("113.33");

        // 3. Sale: CONFIRMED reserves 3 (no ledger row), PACKED deducts them (SALE_OUT at WAC).
        const order = await confirmedOrder(tx, customer.id, variant.id, 3);
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(15);
        expect(v.reservedQty).toBe(3);

        await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(12);
        expect(v.reservedQty).toBe(0);
        const saleOut = await tx.stockMovement.findFirstOrThrow({ where: { variantId: variant.id, type: "SALE_OUT" } });
        expect(saleOut).toMatchObject({ qty: -3, referenceType: "ORDER", referenceId: order.id, actorId: packer.id, stockAfter: 12 });
        expect(saleOut.unitCostSnapshot.toString()).toBe("113.33");
        const packedItem = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
        expect(packedItem.unitCostSnapshot?.toString()).toBe("113.33");

        // 4. Cancel after pack → RETURN_IN at the frozen snapshot cost.
        await moveOrderStatus(tx, { id: order.id, status: "PACKED", items: [packedItem] }, "CANCELLED", admin.id, "test cancel");
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(15);
        const returnIn = await tx.stockMovement.findFirstOrThrow({ where: { variantId: variant.id, type: "RETURN_IN" } });
        expect(returnIn.qty).toBe(3);
        expect(returnIn.unitCostSnapshot.toString()).toBe("113.33");

        // 5. Manual adjustment −2 (reason kept as the ledger note).
        const adj = await adjustStock(tx, { variantId: variant.id, qty: -2, reason: "Stock count found 2 short" }, admin.id);
        expect(adj.note).toBe("Stock count found 2 short");
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(13);

        // 6. Damage write-off of 1 → DAMAGE_OUT + an expense of 1 × WAC.
        const { movement, expense } = await writeOffDamagedStock(tx, { variantId: variant.id, qty: 1, reason: "Torn seam" }, admin.id);
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(12);
        expect(movement).toMatchObject({ type: "DAMAGE_OUT", qty: -1, referenceType: "DAMAGE" });
        expect(expense.amount.toString()).toBe("113.33");
        expect(expense.stockMovementId).toBe(movement.id);
        const category = await tx.expenseCategory.findUniqueOrThrow({ where: { id: expense.categoryId } });
        expect(category.name).toBe(WRITE_OFF_EXPENSE_CATEGORY);

        // stockAfter reads as a running balance of the ledger.
        const ledger = await tx.stockMovement.findMany({ where: { variantId: variant.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        let running = 0;
        for (const row of ledger) {
          running += row.qty;
          expect(row.stockAfter).toBe(running);
        }
        expect(ledger.map((r) => r.type)).toEqual(["PURCHASE_IN", "PURCHASE_IN", "SALE_OUT", "RETURN_IN", "ADJUSTMENT", "DAMAGE_OUT"]);
      });
    },
    TIMEOUT,
  );

  it(
    "holds through a long random mix of stock operations on several variants",
    async () => {
      // Deterministic PRNG so a failure is reproducible.
      let seed = 20260923;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

      await inRolledBackTransaction(async (tx) => {
        const { admin, packer, customer, supplier } = await fixtures(tx);
        const variants = [await makeScratchVariant(tx, "R1"), await makeScratchVariant(tx, "R2")];

        for (let step = 0; step < 16; step++) {
          const target = pick(variants);
          const current = await tx.productVariant.findUniqueOrThrow({ where: { id: target.id } });
          const op = current.stockQty < 3 ? "purchase" : pick(["purchase", "sale", "adjust", "damage"]);

          if (op === "purchase") {
            await createPurchase(
              tx,
              {
                supplierId: supplier.id,
                purchaseDate: new Date(),
                allocationMethod: pick(["BY_VALUE", "BY_QTY"] as const),
                transportCost: Math.floor(rand() * 100),
                otherCost: 0,
                amountPaid: 0,
                items: variants.map((vv) => ({ variantId: vv.id, qty: 1 + Math.floor(rand() * 6), unitCost: 50 + Math.floor(rand() * 200) })),
              },
              admin.id,
            );
          } else if (op === "sale") {
            const qty = 1 + Math.floor(rand() * Math.min(2, current.stockQty - current.reservedQty));
            const order = await confirmedOrder(tx, customer.id, target.id, qty);
            await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
            if (rand() < 0.4) {
              const item = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
              await moveOrderStatus(tx, { id: order.id, status: "PACKED", items: [item] }, "CANCELLED", admin.id);
            }
          } else if (op === "adjust") {
            await adjustStock(tx, { variantId: target.id, qty: pick([-1, 1, 2]), reason: "random test adjustment" }, admin.id);
          } else {
            await writeOffDamagedStock(tx, { variantId: target.id, qty: 1, reason: "random test damage" }, admin.id);
          }

          for (const vv of variants) await expectStockMatchesLedger(tx, vv.id);
        }
      });
    },
    TIMEOUT,
  );
});

describe("the database refuses to let them diverge", () => {
  it(
    "rejects a stock change with no ledger row",
    async () => {
      const variant = await prisma.productVariant.findFirstOrThrow({});
      await expect(
        inRolledBackTransaction(async (tx) => {
          await tx.productVariant.update({ where: { id: variant.id }, data: { stockQty: { increment: 1 } } });
          await checkDeferredConstraintsNow(tx);
        }),
      ).rejects.toThrow(/stock\/ledger divergence/);
    },
    TIMEOUT,
  );

  it(
    "rejects a ledger row with no stock change",
    async () => {
      const variant = await prisma.productVariant.findFirstOrThrow({});
      await expect(
        inRolledBackTransaction(async (tx) => {
          await tx.stockMovement.create({
            data: { variantId: variant.id, type: "ADJUSTMENT", qty: 1, stockAfter: variant.stockQty + 1, unitCostSnapshot: 0, referenceType: "ADJUSTMENT" },
          });
          await checkDeferredConstraintsNow(tx);
        }),
      ).rejects.toThrow(/stock\/ledger divergence/);
    },
    TIMEOUT,
  );

  it(
    "rejects a bare stock write at real COMMIT time, not only in the test helper",
    async () => {
      const before = await prisma.productVariant.findFirstOrThrow({});
      await expect(prisma.productVariant.update({ where: { id: before.id }, data: { stockQty: { increment: 1 } } })).rejects.toThrow(
        /stock\/ledger divergence/,
      );
      const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.stockQty).toBe(before.stockQty);
    },
    TIMEOUT,
  );

  it(
    "keeps the ledger append-only: UPDATE and DELETE are refused",
    async () => {
      const row = await prisma.stockMovement.findFirstOrThrow({});
      await expect(prisma.stockMovement.update({ where: { id: row.id }, data: { qty: row.qty + 1 } })).rejects.toThrow(/append-only/);
      await expect(prisma.stockMovement.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    },
    TIMEOUT,
  );

  it(
    "rolls back both the stock change and the ledger row when anything later in the transaction fails",
    async () => {
      const variant = await prisma.productVariant.findFirstOrThrow({});
      const ledgerCountBefore = await prisma.stockMovement.count({ where: { variantId: variant.id } });

      await expect(
        prisma.$transaction(async (tx) => {
          await recordStockMovement(tx, {
            variantId: variant.id,
            type: "ADJUSTMENT",
            qty: 5,
            unitCost: variant.weightedAvgCost,
            referenceType: "ADJUSTMENT",
            actorId: null,
            note: "should never persist",
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      expect(after.stockQty).toBe(variant.stockQty);
      expect(await prisma.stockMovement.count({ where: { variantId: variant.id } })).toBe(ledgerCountBefore);
    },
    TIMEOUT,
  );
});

describe("guard rails on stock writes", () => {
  it(
    "refuses a movement whose sign contradicts its type, or a zero quantity",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const variant = await makeScratchVariant(tx, "S");
        const base = { variantId: variant.id, unitCost: 0, referenceType: "ADJUSTMENT" as const, actorId: null };
        await expect(recordStockMovement(tx, { ...base, type: "SALE_OUT", qty: 2 })).rejects.toBeInstanceOf(StockMovementError);
        await expect(recordStockMovement(tx, { ...base, type: "PURCHASE_IN", qty: -2 })).rejects.toBeInstanceOf(StockMovementError);
        await expect(recordStockMovement(tx, { ...base, type: "ADJUSTMENT", qty: 0 })).rejects.toBeInstanceOf(StockMovementError);
      });
    },
    TIMEOUT,
  );

  it(
    "won't adjust or write off below zero on hand",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin } = await fixtures(tx);
        const variant = await makeScratchVariant(tx, "Z");
        await expect(adjustStock(tx, { variantId: variant.id, qty: -1, reason: "x" }, admin.id)).rejects.toThrow(/on hand/);
        await expect(writeOffDamagedStock(tx, { variantId: variant.id, qty: 1, reason: "x" }, admin.id)).rejects.toThrow(/on hand/);
        await expect(adjustStock(tx, { variantId: variant.id, qty: 1, reason: "   " }, admin.id)).rejects.toThrow(/reason/);
      });
    },
    TIMEOUT,
  );

  it(
    "won't save a purchase that pays more than its total or repeats a variant",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, supplier } = await fixtures(tx);
        const variant = await makeScratchVariant(tx, "P");
        const base = { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_VALUE" as const, transportCost: 0, otherCost: 0 };
        await expect(
          createPurchase(tx, { ...base, amountPaid: 1001, items: [{ variantId: variant.id, qty: 10, unitCost: 100 }] }, admin.id),
        ).rejects.toBeInstanceOf(PurchaseError);
        await expect(
          createPurchase(
            tx,
            {
              ...base,
              amountPaid: 0,
              items: [
                { variantId: variant.id, qty: 1, unitCost: 100 },
                { variantId: variant.id, qty: 1, unitCost: 100 },
              ],
            },
            admin.id,
          ),
        ).rejects.toBeInstanceOf(PurchaseError);
      });
    },
    TIMEOUT,
  );
});
