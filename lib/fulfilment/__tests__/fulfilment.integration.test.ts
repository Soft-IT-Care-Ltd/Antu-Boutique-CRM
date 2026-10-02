import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/types";
import { applyFulfilmentAction, FulfilmentError } from "@/lib/fulfilment/actions";
import { computeAllocation } from "@/lib/fulfilment/allocation";
import { findFulfilmentDivergences, settleFulfilment } from "@/lib/fulfilment/settle";
import { getWaitingForStock } from "@/lib/fulfilment/waiting";
import { createPurchase } from "@/lib/inventory/purchases";
import { findStockLedgerDivergences, recordStockMovement } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { packOrder, PackStockError } from "@/lib/orders/pack";
import { reserveVariantStock } from "@/lib/orders/stock";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { findVariantByCode } from "@/lib/pos/lookup";
import { createPosSale } from "@/lib/pos/sale";
import { REPORT_BY_KEY } from "@/lib/reports/catalog";
import { parseReportFilters } from "@/lib/reports/filters";
import { runReport } from "@/lib/reports/run";
import { saveSet } from "@/lib/sets/service";
import { resolveSetLines, writeSetLines } from "@/lib/sets/order-lines";
import { getStoreCreditBalance } from "@/lib/store-credit/ledger";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { PHONES, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";
import { createHubTransfer, getHubNeeds } from "@/lib/transfers/hub-needs";
import { receiveTransfer, scanTransferUnit, sendTransfer } from "@/lib/transfers/service";

// C5 — CORRECTIONS.md items 12 and 13: backorders, the automatic
// fulfilment status, ONE oldest-first allocation, the four fulfilment
// actions, the lost-sales report and the POS conflict. What every test
// here protects:
//   * two orders never count the same piece — the older one gets it
//   * a status is recomputed on every stock movement (purchase, transfer,
//     POS sale, packing) without anyone asking
//   * the order status, the "Needed at the packing hub" list, packing's
//     check and the POS warning come from the same allocation
//   * the stored status always equals the allocation computed now

const TIMEOUT = 120_000;
const HUB = SEEDED_LOCATION_IDS.mohammadpur;
const SHOWROOM = SEEDED_LOCATION_IDS.shyamoli;
const CORNER = SEEDED_LOCATION_IDS.parlour;

type Tx = Prisma.TransactionClient;

async function variantWith(tx: Tx, stock: { locationId: string; qty: number }[], opts: { cost?: number; price?: number; productId?: string } = {}) {
  const cost = opts.cost ?? 500;
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow({ orderBy: { sortOrder: "asc" } }), tx.color.findFirstOrThrow({ orderBy: { sortOrder: "asc" } })]);
  const code = testProductCode();
  const productId = opts.productId ?? (await tx.product.create({ data: { code, name: `Fulfilment ${code}`, basePrice: opts.price ?? 1500 } })).id;
  const v = await tx.productVariant.create({ data: { productId, sizeId: size.id, colorId: color.id, sku: testSku(code), weightedAvgCost: cost } });
  for (const s of stock) if (s.qty > 0) await recordStockMovement(tx, { variantId: v.id, locationId: s.locationId, type: "PURCHASE_IN", qty: s.qty, unitCost: cost, referenceType: "OPENING_BALANCE", actorId: null });
  return v;
}

let orderSeq = 0;
/** A confirmed online order placed `minutesAgo`, as the order route writes it (lines reserved), settled. */
async function placeOrder(tx: Tx, se: SessionUser, lines: { variantId: string; qty: number; unitPrice?: number; lineDiscount?: number }[], minutesAgo: number, opts: { deliveryCharge?: number } = {}) {
  const customer = await tx.customer.create({ data: { name: "Fulfilment test", phone: `0171${String(Date.now() + ++orderSeq).slice(-7)}`, createdById: se.id, teamId: se.teamId } });
  const subtotal = lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 1000), 0);
  const discount = lines.reduce((s, l) => s + (l.lineDiscount ?? 0), 0);
  const total = subtotal - discount + (opts.deliveryCharge ?? 0);
  const order = await tx.order.create({
    data: {
      orderNo: `TEST-FUL-${Date.now()}-${++orderSeq}`,
      channel: "ONLINE",
      status: "CONFIRMED",
      customerId: customer.id,
      deliveryCharge: opts.deliveryCharge ?? 0,
      subtotal,
      discountTotal: discount,
      total,
      dueAmount: total,
      createdById: se.id,
      teamId: se.teamId,
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
  for (const l of lines) {
    await tx.orderItem.create({ data: { orderId: order.id, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice ?? 1000, lineDiscount: l.lineDiscount ?? 0 } });
    await reserveVariantStock(tx, l.variantId, l.qty);
  }
  await settleFulfilment(tx);
  return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: { orderBy: { createdAt: "asc" } } } });
}

/**
 * An action expected to fail, inside a savepoint: the tests share one
 * rolled-back transaction, where (unlike the app's own transaction per
 * request) a failed call's partial writes would otherwise stay behind.
 */
async function refused(tx: Tx, fn: () => Promise<unknown>): Promise<unknown> {
  await tx.$executeRawUnsafe("SAVEPOINT refused");
  try {
    await fn();
  } catch (error) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT refused");
    return error;
  }
  await tx.$executeRawUnsafe("RELEASE SAVEPOINT refused");
  throw new Error("expected the call to be refused");
}

const statusOf = async (tx: Tx, orderId: string) => {
  await settleFulfilment(tx);
  return (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { fulfilmentStatus: true } })).fulfilmentStatus;
};

/** The stored fulfilment of every order equals the allocation computed now, and stock still equals the ledger. */
async function expectConsistent(tx: Tx) {
  await settleFulfilment(tx);
  expect(await findFulfilmentDivergences(tx)).toEqual([]);
  await checkDeferredConstraintsNow(tx);
  expect(await findStockLedgerDivergences(tx)).toEqual([]);
}

async function purchase(tx: Tx, admin: SessionUser, variantId: string, locationId: string, qty: number) {
  const supplier = await tx.supplier.findFirstOrThrow();
  await createPurchase(tx, { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_QTY", transportCost: 0, otherCost: 0, amountPaid: 0, items: [{ variantId, locationId, qty, unitCost: 500 }] }, admin.id);
}

const sellAtShowroom = async (tx: Tx, pos: SessionUser, variantId: string) => {
  const cashWallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
  return createPosSale(tx, { user: pos, cashWalletId: cashWallet.id, hasCostAccess: false, canCreateCustomer: true }, { items: [{ variantId, qty: 1, unitPrice: 1500, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CARD", amount: 1500 }] });
};

describe("fulfilment: one oldest-first allocation (CORRECTIONS.md items 12, 13)", () => {
  it(
    "two orders need the last piece: only the older is Ready to pack — packing, the hub list and the status agree",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [se, packer, admin] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.PACKING), userFor(tx, PHONES.ADMIN)]);
        const v = await variantWith(tx, [{ locationId: HUB, qty: 1 }]);
        // Placed newer-first on purpose: the order they were PLACED in decides, not the order they were written.
        const newer = await placeOrder(tx, se, [{ variantId: v.id, qty: 1 }], 10);
        const older = await placeOrder(tx, se, [{ variantId: v.id, qty: 1 }], 60);
        expect(await statusOf(tx, older.id)).toBe("READY_TO_PACK");
        expect(await statusOf(tx, newer.id)).toBe("WAITING_FOR_STOCK");
        const newerLine = await tx.orderItem.findFirstOrThrow({ where: { orderId: newer.id } });
        expect(newerLine).toMatchObject({ atHubQty: 0, backorderQty: 1 });

        // Packing the newer one would take the older one's piece: refused, naming the older order.
        const packRefused = await refused(tx, () => packOrder(tx, { id: newer.id, status: "CONFIRMED", items: newer.items }, packer.id));
        expect(packRefused).toBeInstanceOf(PackStockError);
        expect((packRefused as Error).message).toContain(older.orderNo);

        // A piece turns up at the showroom: the newer order needs a transfer, and it is the
        // only order on the showroom's "Needed at the packing hub" list.
        await purchase(tx, admin, v.id, SHOWROOM, 1);
        expect(await statusOf(tx, newer.id)).toBe("NEEDS_TRANSFER");
        expect(await statusOf(tx, older.id)).toBe("READY_TO_PACK");
        const needs = (await getHubNeeds(tx, SHOWROOM)).rows.filter((r) => r.variantId === v.id);
        expect(needs.map((r) => [r.orderNo, r.qtyHere])).toEqual([[newer.orderNo, 1]]);
        expect((await tx.orderItem.findFirstOrThrow({ where: { orderId: newer.id } })).transferFrom).toEqual([{ locationId: SHOWROOM, locationName: expect.any(String), qty: 1 }]);

        // The older one packs; the newer one still needs its transfer.
        await packOrder(tx, { id: older.id, status: "CONFIRMED", items: older.items }, packer.id);
        expect(await statusOf(tx, newer.id)).toBe("NEEDS_TRANSFER");
        expect((await tx.order.findUniqueOrThrow({ where: { id: older.id } })).fulfilmentStatus).toBeNull();
        await expectConsistent(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "an outfit set with one missing piece waits — and only that piece is the backorder",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [se, admin] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.ADMIN)]);
        const kurti = await variantWith(tx, [{ locationId: HUB, qty: 5 }]);
        const dupatta = await variantWith(tx, []);
        const plazo = await variantWith(tx, [{ locationId: HUB, qty: 10 }]);
        const set = await saveSet(tx, admin.id, {
          name: `Fulfilment set ${kurti.sku}`,
          price: 3000,
          isActive: true,
          components: [
            { productId: kurti.productId, qty: 1 },
            { productId: dupatta.productId, qty: 1 },
            { productId: plazo.productId, qty: 2 },
          ],
          packaging: [],
        });
        const order = await placeOrder(tx, se, [], 30);
        const lines = await resolveSetLines(tx, [{ setId: set.id, qty: 1, unitPrice: 3000, lineDiscount: 0, choices: [kurti, dupatta, plazo].map((v) => ({ productId: v.productId, variantId: v.id })) }], { hasCostAccess: false });
        for (const child of await writeSetLines(tx, order.id, lines)) await reserveVariantStock(tx, child.variantId, child.qty);

        expect(await statusOf(tx, order.id)).toBe("WAITING_FOR_STOCK");
        const items = await tx.orderItem.findMany({ where: { orderId: order.id }, select: { variantId: true, qty: true, atHubQty: true, backorderQty: true, setLineId: true } });
        const byVariant = Object.fromEntries(items.map((i) => [i.variantId, i]));
        expect(byVariant[kurti.id]).toMatchObject({ qty: 1, atHubQty: 1, backorderQty: 0 });
        expect(byVariant[plazo.id]).toMatchObject({ qty: 2, atHubQty: 2, backorderQty: 0 });
        expect(byVariant[dupatta.id]).toMatchObject({ qty: 1, atHubQty: 0, backorderQty: 1 });
        expect(items.every((i) => i.setLineId !== null)).toBe(true);

        // On the Waiting for stock list: just the dupatta.
        const waiting = (await getWaitingForStock(tx, admin)).orders.find((o) => o.orderId === order.id);
        expect(waiting?.missing.map((m) => [m.variantId, m.qty])).toEqual([[dupatta.id, 1]]);

        // The dupatta arrives: the set is complete at the hub.
        await purchase(tx, admin, dupatta.id, HUB, 1);
        expect(await statusOf(tx, order.id)).toBe("READY_TO_PACK");
        await expectConsistent(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "a purchase and a received transfer give the stock to waiting orders oldest first, and tell the SE and packing",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [se, admin, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.PACKING)]);

        // PURCHASE: three orders wait for a dress nobody has; two arrive.
        const v = await variantWith(tx, []);
        const a = await placeOrder(tx, se, [{ variantId: v.id, qty: 1 }], 90);
        const b = await placeOrder(tx, se, [{ variantId: v.id, qty: 1 }], 60);
        const c = await placeOrder(tx, se, [{ variantId: v.id, qty: 1 }], 30);
        for (const o of [a, b, c]) expect(await statusOf(tx, o.id)).toBe("WAITING_FOR_STOCK");
        await purchase(tx, admin, v.id, HUB, 2);
        // No settle called here: the purchase itself recomputed them.
        const now = await tx.order.findMany({ where: { id: { in: [a.id, b.id, c.id] } }, select: { id: true, fulfilmentStatus: true, waitingSince: true } });
        const status = Object.fromEntries(now.map((o) => [o.id, o.fulfilmentStatus]));
        expect([status[a.id], status[b.id], status[c.id]]).toEqual(["READY_TO_PACK", "READY_TO_PACK", "WAITING_FOR_STOCK"]);
        expect(now.find((o) => o.id === a.id)?.waitingSince).toBeNull();
        const told = await tx.notification.findMany({ where: { kind: "ORDER_STOCK_ARRIVED", href: { in: [`/orders/${a.id}`, `/orders/${b.id}`, `/orders/${c.id}`] } }, select: { userId: true, href: true } });
        expect(told.filter((n) => n.href === `/orders/${a.id}`).map((n) => n.userId)).toEqual(expect.arrayContaining([se.id, packer.id]));
        expect(told.some((n) => n.href === `/orders/${c.id}`)).toBe(false);

        // TRANSFER: two orders, the dress is at the showroom only.
        const w = await variantWith(tx, [{ locationId: SHOWROOM, qty: 2 }]);
        const d = await placeOrder(tx, se, [{ variantId: w.id, qty: 1 }], 80);
        const e = await placeOrder(tx, se, [{ variantId: w.id, qty: 1 }], 20);
        expect(await statusOf(tx, d.id)).toBe("NEEDS_TRANSFER");
        expect(await statusOf(tx, e.id)).toBe("NEEDS_TRANSFER");
        // The showroom sends ONE (raised for the older order) — still Needs transfer while on its way …
        const t = await createHubTransfer(tx, admin, { fromLocationId: SHOWROOM, picks: [{ orderId: d.id, variantId: w.id, qty: 1 }] });
        await scanTransferUnit(tx, admin, t.id, "send", w.sku);
        await sendTransfer(tx, admin, t.id);
        expect((await tx.orderItem.findFirstOrThrow({ where: { orderId: d.id } })).incomingQty).toBe(1);
        expect(await statusOf(tx, d.id)).toBe("NEEDS_TRANSFER");
        // … and the hub receiving it makes the OLDER one Ready to pack, by itself.
        await scanTransferUnit(tx, admin, t.id, "receive", w.sku);
        await receiveTransfer(tx, admin, t.id);
        const after = Object.fromEntries((await tx.order.findMany({ where: { id: { in: [d.id, e.id] } }, select: { id: true, fulfilmentStatus: true } })).map((o) => [o.id, o.fulfilmentStatus]));
        expect([after[d.id], after[e.id]]).toEqual(["READY_TO_PACK", "NEEDS_TRANSFER"]);
        expect(await tx.notification.count({ where: { kind: "ORDER_STOCK_ARRIVED", href: `/orders/${d.id}`, userId: se.id } })).toBe(1);
        await expectConsistent(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "a POS sale of a piece an online order was counting on: the POS warns, sells, and the order moves on — its SE is told",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [se, pos] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.POS)]);

        // Only the showroom has it: the order needs it transferred.
        const v = await variantWith(tx, [{ locationId: SHOWROOM, qty: 1 }]);
        const o = await placeOrder(tx, se, [{ variantId: v.id, qty: 1 }], 15);
        expect(await statusOf(tx, o.id)).toBe("NEEDS_TRANSFER");
        // The POS lookup names the order the piece is reserved for …
        expect((await findVariantByCode(tx, v.sku, SHOWROOM))?.heldForOnline).toEqual([{ orderNo: o.orderNo, qty: 1 }]);
        // … but the sale goes through, and the order now waits.
        const sale = await sellAtShowroom(tx, pos, v.id);
        expect(sale.onlineOrdersAffected).toEqual([{ orderNo: o.orderNo, from: "NEEDS_TRANSFER", to: "WAITING_FOR_STOCK" }]);
        expect((await tx.order.findUniqueOrThrow({ where: { id: o.id } })).fulfilmentStatus).toBe("WAITING_FOR_STOCK");
        const lost = await tx.notification.findFirstOrThrow({ where: { userId: se.id, kind: "ORDER_STOCK_LOST", href: `/orders/${o.id}` } });
        expect(lost.body).toMatch(/Sold at .* on the POS/);

        // Another location has one too: the order still needs a transfer — from there now — and nobody is told.
        const w = await variantWith(tx, [{ locationId: SHOWROOM, qty: 1 }, { locationId: CORNER, qty: 1 }]);
        const o2 = await placeOrder(tx, se, [{ variantId: w.id, qty: 1 }], 15);
        const showroomFirst = (await tx.orderItem.findFirstOrThrow({ where: { orderId: o2.id } })).transferFrom as { locationId: string }[];
        expect(showroomFirst.map((f) => f.locationId)).toEqual([SHOWROOM]);
        const sale2 = await sellAtShowroom(tx, pos, w.id);
        expect(sale2.onlineOrdersAffected).toEqual([]);
        expect(await statusOf(tx, o2.id)).toBe("NEEDS_TRANSFER");
        expect(((await tx.orderItem.findFirstOrThrow({ where: { orderId: o2.id } })).transferFrom as { locationId: string }[]).map((f) => f.locationId)).toEqual([CORNER]);
        expect(await tx.notification.count({ where: { href: `/orders/${o2.id}` } })).toBe(0);

        // The one allocation: what the hub list offers per location is exactly what the orders' lines say.
        const { lines } = await computeAllocation(tx);
        for (const locationId of [SHOWROOM, CORNER]) {
          const listed = (await getHubNeeds(tx, locationId)).rows.reduce((s, r) => s + r.qtyHere, 0);
          const counted = lines.reduce((s, l) => s + (l.fromLocations.find((f) => f.locationId === locationId)?.qty ?? 0), 0);
          expect(listed, locationId).toBe(counted);
        }
        await expectConsistent(tx);
      });
    },
    TIMEOUT,
  );
});

describe("fulfilment actions (CORRECTIONS.md item 12)", () => {
  it(
    "substitute, wait and remove: reasons, audit rows, recomputed totals and reservations, lost sales recorded",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [se, admin] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.ADMIN)]);
        const inStock = await variantWith(tx, [{ locationId: HUB, qty: 5 }]);
        const missing = await variantWith(tx, []);
        const other = await variantWith(tx, [{ locationId: HUB, qty: 3 }]);

        // REMOVE: 1 × 1500 + 2 × 1000 − 200 + 100 delivery = 3400 → 1600.
        const o = await placeOrder(tx, se, [{ variantId: inStock.id, qty: 1, unitPrice: 1500 }, { variantId: missing.id, qty: 2, unitPrice: 1000, lineDiscount: 200 }], 40, { deliveryCharge: 100 });
        expect(await statusOf(tx, o.id)).toBe("WAITING_FOR_STOCK");
        const reservedBefore = (await tx.productVariant.findUniqueOrThrow({ where: { id: missing.id } })).reservedQty;
        expect(await refused(tx, () => applyFulfilmentAction(tx, se, o.id, { action: "REMOVE_ITEM", orderItemId: o.items[0].id, reason: "Not missing" }))).toMatchObject({ message: expect.stringMatching(/nothing on that line is missing/) });
        await applyFulfilmentAction(tx, se, o.id, { action: "REMOVE_ITEM", orderItemId: o.items[1].id, reason: "Customer said ship the kurti alone" });
        const removed = await tx.order.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } });
        expect(removed.items).toHaveLength(1);
        expect([removed.total.toString(), removed.dueAmount.toString(), removed.fulfilmentStatus]).toEqual(["1600", "1600", "READY_TO_PACK"]);
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: missing.id } })).reservedQty).toBe(reservedBefore - 2);
        expect(await tx.fulfilmentAction.findFirstOrThrow({ where: { orderId: o.id, kind: "REMOVE_ITEM" } })).toMatchObject({ variantId: missing.id, qty: 2, reason: "Customer said ship the kurti alone" });
        expect((await tx.fulfilmentAction.findFirstOrThrow({ where: { orderId: o.id, kind: "REMOVE_ITEM" } })).value.toString()).toBe("1800");
        const audit = await tx.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: "order.fulfilment.remove_item" } });
        expect(audit.before).toMatchObject({ total: "3400", fulfilmentStatus: "WAITING_FOR_STOCK" });
        expect(audit.after).toMatchObject({ total: "1600", fulfilmentStatus: "READY_TO_PACK", lostValue: "1800.00" });
        // The last item can't be removed — that's a cancel.
        expect(await refused(tx, () => applyFulfilmentAction(tx, se, o.id, { action: "REMOVE_ITEM", orderItemId: removed.items[0].id, reason: "x x x" }))).toBeInstanceOf(FulfilmentError);

        // SUBSTITUTE: the missing dress for another one the customer agreed to, at its own price.
        const s = await placeOrder(tx, se, [{ variantId: missing.id, qty: 1, unitPrice: 1000 }], 35);
        expect(await refused(tx, () => applyFulfilmentAction(tx, se, s.id, { action: "SUBSTITUTE", orderItemId: s.items[0].id, variantId: other.id, unitPrice: 100, lineDiscount: 0, reason: "Below cost" }))).toMatchObject({ message: expect.stringMatching(/below the minimum/) });
        await applyFulfilmentAction(tx, se, s.id, { action: "SUBSTITUTE", orderItemId: s.items[0].id, variantId: other.id, unitPrice: 1200, lineDiscount: 0, reason: "Customer took the blue one" });
        const swapped = await tx.order.findUniqueOrThrow({ where: { id: s.id }, include: { items: true } });
        expect(swapped.items.map((i) => [i.variantId, i.qty])).toEqual([[other.id, 1]]);
        expect([swapped.total.toString(), swapped.fulfilmentStatus]).toEqual(["1200", "READY_TO_PACK"]);
        expect(await tx.fulfilmentAction.findFirstOrThrow({ where: { orderId: s.id } })).toMatchObject({ kind: "SUBSTITUTE", variantId: missing.id, substituteVariantId: other.id, substituteQty: 1 });

        // WAIT: an expected date; refused once nothing is missing.
        const wt = await placeOrder(tx, se, [{ variantId: missing.id, qty: 1 }], 30);
        await applyFulfilmentAction(tx, se, wt.id, { action: "WAIT", reason: "Happy to wait for the delivery", expectedOn: "2030-01-15" });
        expect((await tx.order.findUniqueOrThrow({ where: { id: wt.id } })).stockExpectedOn?.toISOString()).toBe("2030-01-14T18:00:00.000Z");
        expect(await refused(tx, () => applyFulfilmentAction(tx, se, s.id, { action: "WAIT", reason: "Nothing to wait for" }))).toMatchObject({ message: expect.stringMatching(/nothing to wait for/) });
        // A reason is required.
        expect(await refused(tx, () => applyFulfilmentAction(tx, se, wt.id, { action: "WAIT", reason: "  " } as never))).toBeInstanceOf(FulfilmentError);

        // The lost-sales report: the removed line, by product.
        const parsed = parseReportFilters(REPORT_BY_KEY.stockouts, {});
        if (!parsed.ok) throw new Error(parsed.error);
        const report = await runReport(tx, admin, "stockouts", parsed.filters);
        const row = report.tables.find((t) => t.id === "by-product")!.rows.find((r) => String(r.product).startsWith("Fulfilment") && r.removedUnits === 2);
        expect(row).toMatchObject({ removedUnits: 2, value: "1800.00" });
        expect(report.tables.find((t) => t.id === "substitutions")!.rows.some((r) => r.orderNo === s.orderNo)).toBe(true);
        await expectConsistent(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "cancel for a stock-out, and the P3.2 rules when the customer has paid more than the new total",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [se, packer, admin] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.PACKING), userFor(tx, PHONES.ADMIN)]);
        const missing = await variantWith(tx, []);
        const inStock = await variantWith(tx, [{ locationId: HUB, qty: 5 }]);
        const bkash = await tx.wallet.findFirstOrThrow({ where: { type: "BKASH", isActive: true } });
        const pay = async (orderId: string, amount: number) => {
          await tx.payment.create({ data: { orderId, amount, method: "BKASH", walletId: bkash.id, verified: true, verifiedAt: new Date(), verifiedById: admin.id, receivedById: se.id } });
          await recomputeOrderDueAmount(tx, orderId);
        };

        // CANCEL needs something to be out of stock.
        const fine = await placeOrder(tx, se, [{ variantId: inStock.id, qty: 1 }], 30);
        expect(await refused(tx, () => applyFulfilmentAction(tx, se, fine.id, { action: "CANCEL", reason: "Changed mind" }))).toMatchObject({ message: expect.stringMatching(/Nothing on this order is out of stock/) });

        // A 1000 order with 500 paid by bKash, cancelled for a stock-out.
        const c = await placeOrder(tx, se, [{ variantId: missing.id, qty: 1, unitPrice: 1000 }], 25);
        await pay(c.id, 500);
        // Packing can't decide where money goes; without a choice the SE is asked for one.
        expect(await refused(tx, () => applyFulfilmentAction(tx, packer, c.id, { action: "CANCEL", reason: "Supplier out too" }))).toMatchObject({ status: 403 });
        const ask = await refused(tx, () => applyFulfilmentAction(tx, se, c.id, { action: "CANCEL", reason: "Supplier out too" }));
        expect(ask).toBeInstanceOf(FulfilmentError);
        expect(ask).toMatchObject({ status: 409, body: { overpaid: "500.00" } });
        const reservedBefore = (await tx.productVariant.findUniqueOrThrow({ where: { id: missing.id } })).reservedQty;
        const done = await applyFulfilmentAction(tx, se, c.id, { action: "CANCEL", reason: "Supplier out too", settlement: { kind: "STORE_CREDIT" } });
        expect(done).toMatchObject({ status: "CANCELLED", fulfilmentStatus: null, settlement: { kind: "STORE_CREDIT", amount: "500.00" } });
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: missing.id } })).reservedQty).toBe(reservedBefore - 1);
        expect(await getStoreCreditBalance(tx, c.customerId!)).toBe("500.00");
        expect(await tx.fulfilmentAction.findFirstOrThrow({ where: { orderId: c.id, kind: "CANCEL" } })).toMatchObject({ qty: 1, settlement: "STORE_CREDIT" });
        expect((await tx.orderStatusHistory.findFirstOrThrow({ where: { orderId: c.id, toStatus: "CANCELLED" } })).note).toMatch(/stock-out: Supplier out too/);

        // REMOVE leaving 1500 paid on a 1000 order: the 500 goes back as a refund request (a second person approves).
        const r = await placeOrder(tx, se, [{ variantId: inStock.id, qty: 1, unitPrice: 1000 }, { variantId: missing.id, qty: 1, unitPrice: 500 }], 20);
        await pay(r.id, 1500);
        const refunded = await applyFulfilmentAction(tx, se, r.id, { action: "REMOVE_ITEM", orderItemId: r.items[1].id, reason: "Ship the rest", settlement: { kind: "REFUND", method: "BKASH" } });
        expect(refunded.settlement).toEqual({ kind: "REFUND", amount: "500.00" });
        const refund = await tx.payment.findFirstOrThrow({ where: { orderId: r.id, kind: "REFUND" } });
        expect([refund.amount.toString(), refund.refundStatus]).toEqual(["-500", "PENDING"]);
        // Pending: the order still shows 500 overpaid until it is approved.
        expect((await tx.order.findUniqueOrThrow({ where: { id: r.id } })).dueAmount.toString()).toBe("-500");
        await expectConsistent(tx);
      });
    },
    TIMEOUT,
  );
});
