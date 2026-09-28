import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { adjustStock, writeOffDamagedStock } from "@/lib/inventory/adjustments";
import { SHORTAGE_EXPENSE_CATEGORY, WRITE_OFF_EXPENSE_CATEGORY } from "@/lib/inventory/constants";
import { findStockLedgerDivergences, recordStockMovement, StockMovementError } from "@/lib/inventory/ledger";
import { createPurchase, PurchaseError } from "@/lib/inventory/purchases";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { packOrder, PackStockError } from "@/lib/orders/pack";
import { reserveVariantStock } from "@/lib/orders/stock";
import { createPosSale } from "@/lib/pos/sale";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { PHONES, runCounterExchange, runOnlineExchange, runReturnWithDamage, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// CLAUDE.md rule 2 / PRD §6 invariant 2: a stock change and its
// stock_movements row are written in one transaction, so
// sum(stock_movements.qty) per variant must always equal stock_qty.
//
// C3 (CORRECTIONS.md "Changes to existing rules" 1): stock is held per
// location, so the invariant is now per (variant, location) — each
// location's stock = the sum of that location's ledger rows — and the
// variant's total is the sum of its locations.
//
// Requires `npm run db:seed` against DATABASE_URL (for sizes/colours/users/
// a customer). Everything that writes runs inside inRolledBackTransaction,
// so the shared database is left untouched.

const TIMEOUT = 120_000;

const HUB = SEEDED_LOCATION_IDS.mohammadpur;
const SHOWROOM = SEEDED_LOCATION_IDS.shyamoli;
const CORNER = SEEDED_LOCATION_IDS.parlour;

async function ledgerSum(tx: Prisma.TransactionClient, variantId: string, locationId?: string): Promise<number> {
  const agg = await tx.stockMovement.aggregate({ where: { variantId, ...(locationId ? { locationId } : {}) }, _sum: { qty: true } });
  return agg._sum.qty ?? 0;
}

async function qtyAt(tx: Prisma.TransactionClient, variantId: string, locationId: string): Promise<number> {
  const row = await tx.variantStock.findUnique({ where: { variantId_locationId: { variantId, locationId } } });
  return row?.qty ?? 0;
}

/**
 * The invariant, checked three ways: the total against the whole ledger;
 * every location against its own rows (any location either side knows
 * about); and by firing the DB's own commit-time triggers.
 */
async function expectStockMatchesLedger(tx: Prisma.TransactionClient, variantId: string) {
  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  expect(await ledgerSum(tx, variantId)).toBe(variant.stockQty);
  const [stocks, ledgerLocations] = await Promise.all([
    tx.variantStock.findMany({ where: { variantId } }),
    tx.stockMovement.groupBy({ by: ["locationId"], where: { variantId } }),
  ]);
  const locationIds = new Set([...stocks.map((s) => s.locationId), ...ledgerLocations.map((l) => l.locationId)]);
  for (const locationId of locationIds) {
    expect(await ledgerSum(tx, variantId, locationId), `variant ${variantId} at ${locationId}`).toBe(await qtyAt(tx, variantId, locationId));
  }
  expect(stocks.reduce((sum, s) => sum + s.qty, 0)).toBe(variant.stockQty);
  await checkDeferredConstraintsNow(tx);
  return variant;
}

async function makeScratchVariant(tx: Prisma.TransactionClient, tag: string) {
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow({}), tx.color.findFirstOrThrow({})]);
  const code = testProductCode();
  const product = await tx.product.create({
    data: { code, name: `Ledger test ${tag}`, basePrice: 1000 },
  });
  return tx.productVariant.create({
    data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: testSku(code) },
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
    "holds after a purchase, a sale (pack), a cancel-after-pack, an adjustment and a write-off — with WAC, costs and locations right",
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
            items: [{ variantId: variant.id, locationId: HUB, qty: 10, unitCost: 100 }],
          },
          admin.id,
        );
        expect(p1.totalCost.toString()).toBe("1050");
        expect(p1.dueAmount.toString()).toBe("550");
        let v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(10);
        expect(v.weightedAvgCost.toString()).toBe("105");
        expect(await qtyAt(tx, variant.id, HUB)).toBe(10);

        // 2. Purchase 5 @ ৳130 into the showroom → WAC (one cost per variant,
        // wherever it sits) = (10 × 105 + 5 × 130) ÷ 15 = 113.33.
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
            items: [{ variantId: variant.id, locationId: SHOWROOM, qty: 5, unitCost: 130 }],
          },
          admin.id,
        );
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(15);
        expect(v.weightedAvgCost.toString()).toBe("113.33");
        expect([await qtyAt(tx, variant.id, HUB), await qtyAt(tx, variant.id, SHOWROOM)]).toEqual([10, 5]);

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
        // Packed from the hub (C3): the showroom's 5 are untouched.
        expect(saleOut).toMatchObject({ qty: -3, locationId: HUB, referenceType: "ORDER", referenceId: order.id, actorId: packer.id, stockAfter: 12, locationStockAfter: 7 });
        expect(await qtyAt(tx, variant.id, SHOWROOM)).toBe(5);
        expect(saleOut.unitCostSnapshot.toString()).toBe("113.33");
        const packedItem = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
        expect(packedItem.unitCostSnapshot?.toString()).toBe("113.33");

        // 4. Cancel after pack → RETURN_IN at the frozen snapshot cost.
        await moveOrderStatus(tx, { id: order.id, status: "PACKED", items: [packedItem] }, "CANCELLED", admin.id, "test cancel");
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(15);
        const returnIn = await tx.stockMovement.findFirstOrThrow({ where: { variantId: variant.id, type: "RETURN_IN" } });
        expect(returnIn.qty).toBe(3);
        // Back to where it was packed from.
        expect(returnIn.locationId).toBe(HUB);
        expect(await qtyAt(tx, variant.id, HUB)).toBe(10);
        expect(returnIn.unitCostSnapshot.toString()).toBe("113.33");

        // 5. Manual adjustment −2 (reason kept as the ledger note) → a "Stock shortage" expense of 2 × WAC.
        const adj = await adjustStock(tx, { variantId: variant.id, locationId: HUB, qty: -2, reason: "Stock count found 2 short" }, admin.id);
        expect(adj.movement.note).toBe("Stock count found 2 short");
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(13);
        expect(adj.expense!.amount.toString()).toBe("226.66");
        expect(await tx.expenseCategory.findUniqueOrThrow({ where: { id: adj.expense!.categoryId } })).toMatchObject({ name: SHORTAGE_EXPENSE_CATEGORY, kind: "STOCK_SHORTAGE", isSystem: true });

        // …one of them turns up: +1 reverses into the same category as a credit, leaving the net loss.
        const found = await adjustStock(tx, { variantId: variant.id, locationId: HUB, qty: 1, reason: "Found behind the rack" }, admin.id);
        expect(found.expense!.amount.toString()).toBe("-113.33");
        expect(found.expense!.categoryId).toBe(adj.expense!.categoryId);
        const net = await tx.expense.aggregate({ where: { stockMovementId: { in: [adj.movement.id, found.movement.id] } }, _sum: { amount: true } });
        expect(net._sum.amount!.toString()).toBe("113.33");
        await adjustStock(tx, { variantId: variant.id, locationId: HUB, qty: -1, reason: "Recount — really gone" }, admin.id);
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(13);

        // 6. Damage write-off of 1 at the showroom → DAMAGE_OUT + an expense of 1 × WAC.
        const { movement, expense } = await writeOffDamagedStock(tx, { variantId: variant.id, locationId: SHOWROOM, qty: 1, reason: "Torn seam" }, admin.id);
        v = await expectStockMatchesLedger(tx, variant.id);
        expect(v.stockQty).toBe(12);
        expect(movement).toMatchObject({ type: "DAMAGE_OUT", qty: -1, referenceType: "DAMAGE", locationId: SHOWROOM, locationStockAfter: 4 });
        expect([await qtyAt(tx, variant.id, HUB), await qtyAt(tx, variant.id, SHOWROOM)]).toEqual([8, 4]);
        expect(expense!.amount.toString()).toBe("113.33");
        expect(expense!.stockMovementId).toBe(movement.id);
        const category = await tx.expenseCategory.findUniqueOrThrow({ where: { id: expense!.categoryId } });
        expect(category).toMatchObject({ name: WRITE_OFF_EXPENSE_CATEGORY, kind: "DAMAGE_WRITE_OFF", isSystem: true });

        // stockAfter reads as a running balance of the ledger, and
        // locationStockAfter as each location's own running balance.
        const ledger = await tx.stockMovement.findMany({ where: { variantId: variant.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        let running = 0;
        const runningAt = new Map<string, number>();
        for (const row of ledger) {
          running += row.qty;
          runningAt.set(row.locationId, (runningAt.get(row.locationId) ?? 0) + row.qty);
          expect(row.stockAfter).toBe(running);
          expect(row.locationStockAfter).toBe(runningAt.get(row.locationId));
        }
        expect(ledger.map((r) => r.type)).toEqual(["PURCHASE_IN", "PURCHASE_IN", "SALE_OUT", "RETURN_IN", "ADJUSTMENT", "ADJUSTMENT", "ADJUSTMENT", "DAMAGE_OUT"]);
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
        const locations = [HUB, SHOWROOM, CORNER];

        for (let step = 0; step < 20; step++) {
          const target = pick(variants);
          const where = pick(locations);
          const current = await tx.productVariant.findUniqueOrThrow({ where: { id: target.id } });
          const atHub = await qtyAt(tx, target.id, HUB);
          const atWhere = await qtyAt(tx, target.id, where);
          let op = pick(["purchase", "sale", "adjust", "damage"]);
          // Packing needs the units at the hub; adjust/damage need them where they happen.
          if (op === "sale" && atHub - current.reservedQty < 1) op = "purchase";
          if ((op === "adjust" || op === "damage") && atWhere < 2) op = "purchase";

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
                items: variants.map((vv) => ({ variantId: vv.id, locationId: pick(locations), qty: 1 + Math.floor(rand() * 6), unitCost: 50 + Math.floor(rand() * 200) })),
              },
              admin.id,
            );
          } else if (op === "sale") {
            const qty = 1 + Math.floor(rand() * Math.min(2, atHub - current.reservedQty));
            const order = await confirmedOrder(tx, customer.id, target.id, qty);
            await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
            if (rand() < 0.4) {
              const item = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
              await moveOrderStatus(tx, { id: order.id, status: "PACKED", items: [item] }, "CANCELLED", admin.id);
            }
          } else if (op === "adjust") {
            await adjustStock(tx, { variantId: target.id, locationId: where, qty: pick([-1, 1, 2]), reason: "random test adjustment" }, admin.id);
          } else {
            await writeOffDamagedStock(tx, { variantId: target.id, locationId: where, qty: 1, reason: "random test damage" }, admin.id);
          }

          for (const vv of variants) await expectStockMatchesLedger(tx, vv.id);
        }
      });
    },
    TIMEOUT,
  );
});

// P3.2 — the return and exchange flows (lib/returns/cases.ts) move stock
// through the same ledger: the invariant must survive every one of them.
describe("returns and exchanges keep stock equal to the ledger", () => {
  it(
    "after an online exchange, a counter exchange and a return with one damaged unit",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const online = await runOnlineExchange(tx);
        const counter = await runCounterExchange(tx);
        const returned = await runReturnWithDamage(tx);
        expect(await findStockLedgerDivergences(tx)).toEqual([]);
        await checkDeferredConstraintsNow(tx);

        // C3: courier returns and online exchanges come back into the
        // packing hub; a counter exchange swaps at the showroom.
        const inspections = [online.caseId, returned.caseId].map((id) => tx.returnCase.findUniqueOrThrow({ where: { id }, select: { inspectionId: true } }));
        for (const { inspectionId } of await Promise.all(inspections)) {
          const rows = await tx.stockMovement.findMany({ where: { referenceId: inspectionId! } });
          expect(rows.length).toBeGreaterThan(0);
          expect(new Set(rows.map((r) => r.locationId))).toEqual(new Set([HUB]));
        }
        const counterRows = await tx.stockMovement.findMany({ where: { OR: [{ referenceId: counter.result.replacementOrderId }, { referenceType: "EXCHANGE", variantId: counter.catalog.m.id }] } });
        expect(counterRows.filter((r) => r.type !== "PACKAGING_OUT").length).toBeGreaterThan(0);
        expect(new Set(counterRows.map((r) => r.locationId))).toEqual(new Set([SHOWROOM]));
      });
    },
    TIMEOUT,
  );
});

// C3 — the Verify Round 1 check 1 shape, on this prompt's flows: a day of
// purchases into several locations, online sales packed at the hub, POS
// sales at the showroom (one driving it negative), returns, exchanges and
// adjustments. At the end, for EVERY variant at EVERY location in the
// database, stock = sum of that location's ledger rows.
describe("per-location stock = per-location ledger, through a whole day (C3)", () => {
  it(
    "holds for every variant at every location after purchases, sales, POS sales, returns, exchanges, packing and adjustments",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, packer, customer, supplier } = await fixtures(tx);
        const pos = await userFor(tx, PHONES.POS);
        const [a, b] = [await makeScratchVariant(tx, "DAY-A"), await makeScratchVariant(tx, "DAY-B")];

        // Purchases into three locations, one of them a single purchase split over two.
        await createPurchase(
          tx,
          {
            supplierId: supplier.id,
            purchaseDate: new Date(),
            allocationMethod: "BY_QTY",
            transportCost: 60,
            otherCost: 0,
            amountPaid: 0,
            items: [
              { variantId: a.id, locationId: HUB, qty: 6, unitCost: 300 },
              { variantId: a.id, locationId: SHOWROOM, qty: 2, unitCost: 300 },
              { variantId: b.id, locationId: HUB, qty: 4, unitCost: 500 },
              { variantId: b.id, locationId: CORNER, qty: 3, unitCost: 500 },
            ],
          },
          admin.id,
        );
        expect([await qtyAt(tx, a.id, HUB), await qtyAt(tx, a.id, SHOWROOM), await qtyAt(tx, b.id, HUB), await qtyAt(tx, b.id, CORNER)]).toEqual([6, 2, 4, 3]);

        // An online sale, packed at the hub.
        const order = await confirmedOrder(tx, customer.id, a.id, 2);
        await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
        expect(await qtyAt(tx, a.id, HUB)).toBe(4);

        // Packing refuses what isn't at the hub, naming where it is — even
        // though the shop as a whole holds enough.
        const cornerOnly = await makeScratchVariant(tx, "DAY-C");
        await createPurchase(tx, { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_QTY", transportCost: 0, otherCost: 0, amountPaid: 0, items: [{ variantId: cornerOnly.id, locationId: CORNER, qty: 2, unitCost: 100 }] }, admin.id);
        const stuck = await confirmedOrder(tx, customer.id, cornerOnly.id, 1);
        await expect(packOrder(tx, { id: stuck.id, status: "CONFIRMED", items: stuck.items }, packer.id)).rejects.toThrow(PackStockError);
        await expect(packOrder(tx, { id: stuck.id, status: "CONFIRMED", items: stuck.items }, packer.id)).rejects.toThrow(/2 at Parlour Sales Corner/);

        // POS sales at the showroom: one within its stock, one beyond it.
        const cashWallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
        const ctx = { user: pos, cashWalletId: cashWallet.id, hasCostAccess: false, canCreateCustomer: true };
        await createPosSale(tx, ctx, { items: [{ variantId: a.id, qty: 2, unitPrice: 1000, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CARD", amount: 2000 }] });
        expect([await qtyAt(tx, a.id, SHOWROOM), await qtyAt(tx, a.id, HUB)]).toEqual([0, 4]);
        await createPosSale(tx, ctx, { items: [{ variantId: b.id, qty: 1, unitPrice: 1000, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CARD", amount: 1000 }], acknowledgeNegativeStock: true });
        expect(await qtyAt(tx, b.id, SHOWROOM)).toBe(-1);
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: b.id } })).stockQty).toBe(6);

        // Returns and exchanges (their own catalog), and adjustments that
        // put the showroom right and correct the corner.
        await runOnlineExchange(tx);
        await runCounterExchange(tx);
        await runReturnWithDamage(tx);
        await adjustStock(tx, { variantId: b.id, locationId: SHOWROOM, qty: 1, reason: "Count: the rail dress was ours" }, admin.id);
        await adjustStock(tx, { variantId: b.id, locationId: CORNER, qty: -1, reason: "Count: one short" }, admin.id);
        await writeOffDamagedStock(tx, { variantId: a.id, locationId: HUB, qty: 1, reason: "Lipstick stain" }, admin.id);
        expect([await qtyAt(tx, b.id, SHOWROOM), await qtyAt(tx, b.id, CORNER), await qtyAt(tx, a.id, HUB)]).toEqual([0, 2, 3]);

        for (const v of [a, b, cornerOnly]) await expectStockMatchesLedger(tx, v.id);
        // Every variant at every location in the database — not just this test's.
        expect(await findStockLedgerDivergences(tx)).toEqual([]);
        const everyPair = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*) AS n FROM (
            SELECT s."variantId", s."locationId", s."qty", COALESCE(SUM(m."qty"), 0) AS ledger
            FROM "variant_stocks" s
            LEFT JOIN "stock_movements" m ON m."variantId" = s."variantId" AND m."locationId" = s."locationId"
            GROUP BY s."variantId", s."locationId", s."qty"
            HAVING s."qty" <> COALESCE(SUM(m."qty"), 0)
          ) bad`;
        expect(Number(everyPair[0].n)).toBe(0);
        const totals = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*) AS n FROM "product_variants" v
          WHERE v."stockQty" <> COALESCE((SELECT SUM(s."qty") FROM "variant_stocks" s WHERE s."variantId" = v."id"), 0)`;
        expect(Number(totals[0].n)).toBe(0);
        await checkDeferredConstraintsNow(tx);
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
            data: { variantId: variant.id, locationId: HUB, type: "ADJUSTMENT", qty: 1, stockAfter: variant.stockQty + 1, locationStockAfter: 0, unitCostSnapshot: 0, referenceType: "ADJUSTMENT" },
          });
          await checkDeferredConstraintsNow(tx);
        }),
      ).rejects.toThrow(/stock\/ledger divergence/);
    },
    TIMEOUT,
  );

  it(
    "rejects a location's stock change with no ledger row, even when the total is kept right",
    async () => {
      const variant = await prisma.productVariant.findFirstOrThrow({ where: { locationStocks: { some: { locationId: HUB } } } });
      await expect(
        inRolledBackTransaction(async (tx) => {
          // Moving a unit hub → showroom by hand: the total is unchanged, but
          // neither location matches its ledger any more.
          await tx.variantStock.update({ where: { variantId_locationId: { variantId: variant.id, locationId: HUB } }, data: { qty: { decrement: 1 } } });
          await tx.variantStock.upsert({ where: { variantId_locationId: { variantId: variant.id, locationId: SHOWROOM } }, create: { variantId: variant.id, locationId: SHOWROOM, qty: 1 }, update: { qty: { increment: 1 } } });
          await checkDeferredConstraintsNow(tx);
        }),
      ).rejects.toThrow(/stock\/ledger divergence on variant .* at location/);
    },
    TIMEOUT,
  );

  it(
    "rejects a ledger row booked to one location while another's stock moved",
    async () => {
      const variant = await prisma.productVariant.findFirstOrThrow({ where: { locationStocks: { some: { locationId: HUB } } } });
      await expect(
        inRolledBackTransaction(async (tx) => {
          await tx.productVariant.update({ where: { id: variant.id }, data: { stockQty: { increment: 1 } } });
          await tx.variantStock.update({ where: { variantId_locationId: { variantId: variant.id, locationId: HUB } }, data: { qty: { increment: 1 } } });
          await tx.stockMovement.create({
            data: { variantId: variant.id, locationId: CORNER, type: "ADJUSTMENT", qty: 1, stockAfter: variant.stockQty + 1, locationStockAfter: 1, unitCostSnapshot: 0, referenceType: "ADJUSTMENT" },
          });
          await checkDeferredConstraintsNow(tx);
        }),
      ).rejects.toThrow(/at location/);
    },
    TIMEOUT,
  );

  it(
    "never deletes a location's stock row",
    async () => {
      const row = await prisma.variantStock.findFirstOrThrow({});
      await expect(prisma.variantStock.delete({ where: { variantId_locationId: { variantId: row.variantId, locationId: row.locationId } } })).rejects.toThrow(/never deleted/);
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
            locationId: HUB,
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
        const base = { variantId: variant.id, locationId: HUB, unitCost: 0, referenceType: "ADJUSTMENT" as const, actorId: null };
        await expect(recordStockMovement(tx, { ...base, type: "SALE_OUT", qty: 2 })).rejects.toBeInstanceOf(StockMovementError);
        await expect(recordStockMovement(tx, { ...base, type: "PURCHASE_IN", qty: -2 })).rejects.toBeInstanceOf(StockMovementError);
        await expect(recordStockMovement(tx, { ...base, type: "ADJUSTMENT", qty: 0 })).rejects.toBeInstanceOf(StockMovementError);
      });
    },
    TIMEOUT,
  );

  it(
    "won't adjust or write off below zero on hand at that location, whatever other locations hold",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, supplier } = await fixtures(tx);
        const variant = await makeScratchVariant(tx, "Z");
        await expect(adjustStock(tx, { variantId: variant.id, locationId: HUB, qty: -1, reason: "x" }, admin.id)).rejects.toThrow(/on hand/);
        await expect(writeOffDamagedStock(tx, { variantId: variant.id, locationId: HUB, qty: 1, reason: "x" }, admin.id)).rejects.toThrow(/on hand/);
        await expect(adjustStock(tx, { variantId: variant.id, locationId: HUB, qty: 1, reason: "   " }, admin.id)).rejects.toThrow(/reason/);
        // 5 at the showroom don't let the hub go below zero.
        await createPurchase(tx, { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_QTY", transportCost: 0, otherCost: 0, amountPaid: 0, items: [{ variantId: variant.id, locationId: SHOWROOM, qty: 5, unitCost: 100 }] }, admin.id);
        await expect(adjustStock(tx, { variantId: variant.id, locationId: HUB, qty: -1, reason: "x" }, admin.id)).rejects.toThrow(/on hand at this location/);
        await expect(writeOffDamagedStock(tx, { variantId: variant.id, locationId: HUB, qty: 1, reason: "x" }, admin.id)).rejects.toThrow(/on hand at this location/);
        await expectStockMatchesLedger(tx, variant.id);
      });
    },
    TIMEOUT,
  );

  it(
    "won't save a purchase that pays more than its total or repeats a variant at one location",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, supplier } = await fixtures(tx);
        const variant = await makeScratchVariant(tx, "P");
        const base = { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_VALUE" as const, transportCost: 0, otherCost: 0 };
        await expect(
          createPurchase(tx, { ...base, amountPaid: 1001, items: [{ variantId: variant.id, locationId: HUB, qty: 10, unitCost: 100 }] }, admin.id),
        ).rejects.toBeInstanceOf(PurchaseError);
        await expect(
          createPurchase(
            tx,
            {
              ...base,
              amountPaid: 0,
              items: [
                { variantId: variant.id, locationId: HUB, qty: 1, unitCost: 100 },
                { variantId: variant.id, locationId: HUB, qty: 1, unitCost: 100 },
              ],
            },
            admin.id,
          ),
        ).rejects.toBeInstanceOf(PurchaseError);
        // The same variant into two locations is two lines of one purchase.
        await createPurchase(
          tx,
          {
            ...base,
            amountPaid: 0,
            items: [
              { variantId: variant.id, locationId: HUB, qty: 1, unitCost: 100 },
              { variantId: variant.id, locationId: SHOWROOM, qty: 2, unitCost: 100 },
            ],
          },
          admin.id,
        );
        expect([await qtyAt(tx, variant.id, HUB), await qtyAt(tx, variant.id, SHOWROOM)]).toEqual([1, 2]);
      });
    },
    TIMEOUT,
  );
});
