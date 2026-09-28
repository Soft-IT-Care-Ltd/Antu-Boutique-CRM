import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { recordStockMovement } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { toNumber } from "@/lib/money";
import { renderInvoiceHtml } from "@/lib/orders/invoice";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { generateOrderNumber } from "@/lib/orders/order-number";
import { packOrder } from "@/lib/orders/pack";
import { reserveVariantStock } from "@/lib/orders/stock";
import { computeOrderTotals, recomputeOrderDueAmount } from "@/lib/orders/totals";
import { PACKAGING_USED_CATEGORY_ID } from "@/lib/packaging/consume";
import { setPackaging } from "@/lib/packaging/service";
import { loadPackingOrder, serializePackingOrderDetail } from "@/lib/packing/queue";
import { renderPackingSlipHtml } from "@/lib/packing/slip";
import { SUB_ITEM_MARK } from "@/lib/pdf/render";
import { createPosSale } from "@/lib/pos/sale";
import { createCounterExchange } from "@/lib/returns/cases";
import { resolveSetLines, writeSetLines } from "@/lib/sets/order-lines";
import { getSetAvailabilityReport, getSetDetail, saveSet, SetError } from "@/lib/sets/service";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { PHONES, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// P3.3 — outfit sets built from products, sold with a size/colour chosen
// per component (PRD §4.2), and packaging materials taken out of stock at
// packing and at the counter. All in rolled-back transactions on antu_test.

const TIMEOUT = 120_000;

/** A product with the given sizes (first colour), `stock` each at `cost`. */
async function product(tx: Prisma.TransactionClient, opts: { name: string; price: number; cost: number; stock: number[]; kind?: "SELLABLE" | "COMPONENT_ONLY" }) {
  const sizes = await tx.size.findMany({ orderBy: { sortOrder: "asc" }, take: opts.stock.length });
  const color = await tx.color.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
  const code = testProductCode();
  const p = await tx.product.create({ data: { code, name: `${opts.name} ${code}`, basePrice: opts.kind === "COMPONENT_ONLY" ? 0 : opts.price, kind: opts.kind ?? "SELLABLE" } });
  const variants = [];
  for (const [i, size] of sizes.entries()) {
    const v = await tx.productVariant.create({ data: { productId: p.id, sizeId: size.id, colorId: color.id, sku: testSku(code, `${size.code}${i}`), weightedAvgCost: opts.cost } });
    if (opts.stock[i] > 0) await recordStockMovement(tx, { variantId: v.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, type: "PURCHASE_IN", qty: opts.stock[i], unitCost: opts.cost, referenceType: "OPENING_BALANCE", actorId: null });
    variants.push(v);
  }
  return { ...p, variants };
}

/** Kurti ×1 + Dupatta ×1 + Plazo ×2 at ৳3,000 a set. The plazo's second size has only 3 in stock. */
async function eidSet(tx: Prisma.TransactionClient) {
  const admin = await userFor(tx, PHONES.ADMIN);
  const kurti = await product(tx, { name: "Set kurti", price: 1500, cost: 600, stock: [10, 10] });
  const dupatta = await product(tx, { name: "Set dupatta", price: 500, cost: 200, stock: [10] });
  const plazo = await product(tx, { name: "Set plazo", price: 500, cost: 250, stock: [10, 3] });
  const tissue = await product(tx, { name: "Set tissue", price: 0, cost: 2, stock: [100], kind: "COMPONENT_ONLY" });
  const box = await product(tx, { name: "Set box", price: 0, cost: 40, stock: [50], kind: "COMPONENT_ONLY" });
  const set = await saveSet(tx, admin.id, {
    name: `Eid set ${kurti.code}`,
    price: 3000,
    isActive: true,
    components: [
      { productId: kurti.id, qty: 1 },
      { productId: dupatta.id, qty: 1 },
      { productId: plazo.id, qty: 2 },
    ],
    packaging: [{ materialVariantId: box.variants[0].id, qty: 1 }],
  });
  // Each kurti goes out with two sheets of tissue — inside the set too.
  await setPackaging(tx, admin.id, { productId: kurti.id }, [{ materialVariantId: tissue.variants[0].id, qty: 2 }]);
  return { admin, kurti, dupatta, plazo, tissue, box, set };
}

/** A CONFIRMED online order for `qty` sets, as the order route writes it: set line + component lines, reserved. */
async function onlineSetOrder(tx: Prisma.TransactionClient, setId: string, choices: { productId: string; variantId: string }[], qty = 1) {
  const se = await userFor(tx, PHONES.SE);
  const customer = await tx.customer.create({ data: { name: "Set customer", phone: `0171${String(Date.now()).slice(-7)}`, createdById: se.id, teamId: se.teamId } });
  const lines = await resolveSetLines(tx, [{ setId, qty, unitPrice: 3000, lineDiscount: 0, choices }], { hasCostAccess: false });
  const totals = computeOrderTotals(lines[0].children, 100);
  const order = await tx.order.create({
    data: { orderNo: await generateOrderNumber(tx), channel: "ONLINE", status: "CONFIRMED", customerId: customer.id, deliveryCharge: 100, subtotal: totals.subtotal, discountTotal: totals.discountTotal, total: totals.total, dueAmount: totals.total, createdById: se.id, teamId: se.teamId },
  });
  for (const child of await writeSetLines(tx, order.id, lines)) await reserveVariantStock(tx, child.variantId, child.qty);
  return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, setLines: true } });
}

describe("outfit sets (PRD §4.2, P3.3)", () => {
  it(
    "a set sold online reserves the CHOSEN sizes, packing deducts them at their cost, and packing and the invoice show every piece",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { kurti, dupatta, plazo, set } = await eidSet(tx);
        const choices = [
          { productId: kurti.id, variantId: kurti.variants[1].id },
          { productId: dupatta.id, variantId: dupatta.variants[0].id },
          { productId: plazo.id, variantId: plazo.variants[0].id },
        ];
        const order = await onlineSetOrder(tx, set.id, choices);

        // One set line; one line per component, units = units per set × sets.
        expect(order.setLines).toHaveLength(1);
        const byVariant = new Map(order.items.map((i) => [i.variantId, i]));
        expect(byVariant.get(kurti.variants[1].id)?.qty).toBe(1);
        expect(byVariant.get(plazo.variants[0].id)?.qty).toBe(2);
        expect(order.items.every((i) => i.setLineId === order.setLines[0].id)).toBe(true);
        // The set price, exactly, split by list value: 1500 : 500 : 2 × 500.
        expect(toNumber(order.total)).toBe(3100);
        expect(order.items.map((i) => toNumber(i.unitPrice)).sort((a, b) => a - b)).toEqual([500, 500, 1500]);
        // Reserved only the chosen size; the other kurti size is untouched.
        const reserved = async (id: string) => (await tx.productVariant.findUniqueOrThrow({ where: { id } })).reservedQty;
        expect(await reserved(kurti.variants[1].id)).toBe(1);
        expect(await reserved(kurti.variants[0].id)).toBe(0);
        expect(await reserved(plazo.variants[0].id)).toBe(2);

        const packer = await userFor(tx, PHONES.PACKING);
        await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
        const packed = await tx.orderItem.findMany({ where: { orderId: order.id } });
        expect(packed.map((i) => toNumber(i.unitCostSnapshot!)).sort((a, b) => a - b)).toEqual([200, 250, 600]);
        const plazoOut = await tx.stockMovement.findFirstOrThrow({ where: { variantId: plazo.variants[0].id, type: "SALE_OUT" } });
        expect(plazoOut.qty).toBe(-2);
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: plazo.variants[0].id } })).stockQty).toBe(8);

        // Packing sees the full explosion (Gift Valy Round 2 §2.2)…
        const detail = serializePackingOrderDetail((await loadPackingOrder(order.id, tx))!, 24);
        expect(detail.items).toHaveLength(3);
        expect(detail.items.every((i) => i.set?.name === `Eid set ${kurti.code}`)).toBe(true);
        const slip = await renderPackingSlipHtml(detail, "");
        for (const v of [kurti.variants[1], dupatta.variants[0], plazo.variants[0]]) expect(slip).toContain(v.sku);
        // …and the invoice the set with its pieces — no component prices.
        const orderDetail = serializeOrderDetail((await loadOrderDetail(order.id, tx))!);
        const invoice = await renderInvoiceHtml(orderDetail, 1, "");
        expect(invoice).toContain(`Eid set ${kurti.code}`);
        expect(invoice).toContain(`${SUB_ITEM_MARK}${kurti.name}`);
        expect(invoice).not.toContain("৳ 1,500");
        await checkDeferredConstraintsNow(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "availability is min over components of floor(available ÷ qty) for the chosen combination, and the report names the limiting piece",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { kurti, dupatta, plazo, set } = await eidSet(tx);
        const detail = (await getSetDetail(tx, set.id))!;
        // Best combination: kurti 10, dupatta 10, plazo 10 ÷ 2 = 5.
        expect(detail.availableSets).toBe(5);
        expect(detail.limitingProduct).toBe(plazo.name);
        const smallPlazo = detail.components.find((c) => c.productId === plazo.id)!.variants.find((v) => v.id === plazo.variants[1].id)!;
        expect(smallPlazo.available).toBe(3); // 3 ÷ 2 → only 1 set in that size

        // Selling 4 sets on the best plazo drops the set to 1 available.
        await onlineSetOrder(
          tx,
          set.id,
          [
            { productId: kurti.id, variantId: kurti.variants[0].id },
            { productId: dupatta.id, variantId: dupatta.variants[0].id },
            { productId: plazo.id, variantId: plazo.variants[0].id },
          ],
          4,
        );
        const report = (await getSetAvailabilityReport(tx)).find((r) => r.id === set.id)!;
        expect(report.availableSets).toBe(1);
        expect(report.limitingProduct).toBe(plazo.name);
        expect(report.components.find((c) => c.productName === plazo.name)).toMatchObject({ bestSets: 1, bestAvailable: 3 });

        // A piece taken off sale takes the set with it, though its stock is still on the shelf.
        await tx.product.update({ where: { id: dupatta.id }, data: { isActive: false } });
        const offSale = (await getSetAvailabilityReport(tx)).find((r) => r.id === set.id)!;
        expect(offSale.availableSets).toBe(0);
        expect(offSale.limitingProduct).toBe(dupatta.name);
      });
    },
    TIMEOUT,
  );

  it(
    "refuses a set without a size for every piece, a size from the wrong product, and packaging material as a component",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, kurti, dupatta, plazo, tissue, set } = await eidSet(tx);
        await expect(resolveSetLines(tx, [{ setId: set.id, qty: 1, unitPrice: 3000, lineDiscount: 0, choices: [{ productId: kurti.id, variantId: kurti.variants[0].id }] }], { hasCostAccess: false })).rejects.toThrow(
          /pick a size and colour for/,
        );
        await expect(
          resolveSetLines(
            tx,
            [
              {
                setId: set.id,
                qty: 1,
                unitPrice: 3000,
                lineDiscount: 0,
                choices: [
                  { productId: kurti.id, variantId: dupatta.variants[0].id },
                  { productId: dupatta.id, variantId: dupatta.variants[0].id },
                  { productId: plazo.id, variantId: plazo.variants[0].id },
                ],
              },
            ],
            { hasCostAccess: false },
          ),
        ).rejects.toThrow(/isn't one of/);
        // Below the cost of the chosen combination (600 + 200 + 2 × 250) for a role without cost.
        await expect(
          resolveSetLines(tx, [{ setId: set.id, qty: 1, unitPrice: 1000, lineDiscount: 0, choices: [kurti, dupatta, plazo].map((p) => ({ productId: p.id, variantId: p.variants[0].id })) }], { hasCostAccess: false }),
        ).rejects.toThrow(/below the minimum/);
        await expect(
          saveSet(tx, admin.id, { name: "Bad", price: 10, isActive: true, components: [{ productId: kurti.id, qty: 1 }, { productId: tissue.id, qty: 1 }], packaging: [] }),
        ).rejects.toBeInstanceOf(SetError);
      });
    },
    TIMEOUT,
  );

  it(
    "a set at the counter: stock out as POS_SALE_OUT, the bag / tissue / box leave stock, and their cost posts once as Packaging used",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { admin, kurti, dupatta, plazo, tissue, box, set } = await eidSet(tx);
        const bag = await product(tx, { name: "Set bag", price: 0, cost: 15, stock: [20], kind: "COMPONENT_ONLY" });
        await setPackaging(tx, admin.id, { scope: "POS_SALE" }, [{ materialVariantId: bag.variants[0].id, qty: 1 }]);
        // C3 — the counter sells from the Shyamoli showroom's shelf.
        for (const p of [kurti, dupatta, plazo]) {
          await recordStockMovement(tx, { variantId: p.variants[0].id, locationId: SEEDED_LOCATION_IDS.shyamoli, type: "PURCHASE_IN", qty: 2, unitCost: 100, referenceType: "OPENING_BALANCE", actorId: null });
        }
        const pos = await userFor(tx, PHONES.POS);
        const cash = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
        const sale = await createPosSale(tx, { user: pos, cashWalletId: cash.id, hasCostAccess: false, canCreateCustomer: true }, {
          items: [],
          sets: [{ setId: set.id, qty: 1, unitPrice: 3000, lineDiscount: 200, choices: [kurti, dupatta, plazo].map((p) => ({ productId: p.id, variantId: p.variants[0].id })) }],
          cartDiscount: 0,
          customer: null,
          tenders: [{ method: "CARD", amount: 2800 }],
        });
        const order = await tx.order.findUniqueOrThrow({ where: { id: sale.orderId }, include: { items: true } });
        expect(toNumber(order.total)).toBe(2800);
        expect(order.items.reduce((sum, i) => sum + toNumber(i.unitPrice) * i.qty - toNumber(i.lineDiscount), 0)).toBe(2800);
        expect(await tx.stockMovement.count({ where: { referenceId: order.id, type: "POS_SALE_OUT" } })).toBe(3);

        const packaging = await tx.stockMovement.findMany({ where: { referenceId: order.id, type: "PACKAGING_OUT" } });
        const out = new Map(packaging.map((m) => [m.variantId, m.qty]));
        expect(out.get(bag.variants[0].id)).toBe(-1); // per counter sale
        expect(out.get(box.variants[0].id)).toBe(-1); // per set
        expect(out.get(tissue.variants[0].id)).toBe(-2); // per kurti, inside the set
        const expense = await tx.expense.findUniqueOrThrow({ where: { packagingOrderId: order.id } });
        expect(expense.categoryId).toBe(PACKAGING_USED_CATEGORY_ID);
        expect(toNumber(expense.amount)).toBe(15 + 40 + 2 * 2);
        expect(expense.walletId).toBeNull();
        await checkDeferredConstraintsNow(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "one piece of a set is exchanged at the counter without touching the others",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { kurti, dupatta, plazo, set } = await eidSet(tx);
        const order = await onlineSetOrder(tx, set.id, [kurti, dupatta, plazo].map((p) => ({ productId: p.id, variantId: p.variants[0].id })));
        const packer = await userFor(tx, PHONES.PACKING);
        await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
        await tx.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
        const se = await userFor(tx, PHONES.SE);
        const bkash = await tx.wallet.findFirstOrThrow({ where: { type: "BKASH" } });
        await tx.payment.create({ data: { orderId: order.id, amount: 3100, method: "BKASH", walletId: bkash.id, receivedById: se.id, verified: true } });
        await recomputeOrderDueAmount(tx, order.id);

        const plazoLine = order.items.find((i) => i.variantId === plazo.variants[0].id)!;
        const pos = await userFor(tx, PHONES.POS);
        const cash = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
        const result = await createCounterExchange(tx, { user: pos, cashWalletId: cash.id, canCreateCustomer: true }, {
          orderId: order.id,
          reason: "WRONG_SIZE",
          lines: [{ orderItemId: plazoLine.id, qty: 2, replacementVariantId: plazo.variants[1].id, goodQty: 2, damagedQty: 0 }],
          tenders: [],
        });
        // Same product in another size keeps what was paid: nothing to pay, nothing owed.
        expect(result).toMatchObject({ paid: "0.00", storeCreditIssued: "0.00" });
        const after = await tx.orderItem.findMany({ where: { orderId: order.id } });
        expect(after.find((i) => i.id === plazoLine.id)?.returnedQty).toBe(2);
        expect(after.filter((i) => i.id !== plazoLine.id).every((i) => i.returnedQty === 0)).toBe(true);
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: kurti.variants[0].id } })).stockQty).toBe(9);
        await checkDeferredConstraintsNow(tx);
      });
    },
    TIMEOUT,
  );
});
