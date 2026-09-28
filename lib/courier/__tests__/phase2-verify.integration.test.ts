import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/courier/steadfast/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/courier/steadfast/client")>();
  return {
    ...actual,
    getBalance: vi.fn(),
    createOrder: vi.fn(),
    createBulkOrder: vi.fn(),
    statusByCid: vi.fn(),
    statusByInvoice: vi.fn(),
    getPayments: vi.fn(),
    getPaymentDetail: vi.fn(),
  };
});

import { makePackedOrder, orderStatus, sendOne, sessionUserFor, setupIntegration, uniquePhone, webhook } from "@/lib/courier/__tests__/helpers";
import { markKeptItems } from "@/lib/courier/partial-delivery";
import { runSteadfastPayoutsSync } from "@/lib/courier/payouts/sync";
import { defaultCourierPayoutWalletId, ingestCourierStatement } from "@/lib/courier/reconcile";
import * as steadfast from "@/lib/courier/steadfast/client";
import { dhakaDayStartUtc, todayInDhaka, WRITE_OFF_EXPENSE_CATEGORY_ID } from "@/lib/inventory/constants";
import { createPurchase } from "@/lib/inventory/purchases";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { toNumber } from "@/lib/money";
import { applyValidatedOrderEdit, OrderEditConflictError, validateOrderEdit } from "@/lib/orders/apply-edit";
import { StaleOrderStatusError, moveOrderStatus } from "@/lib/orders/lifecycle";
import { packOrder } from "@/lib/orders/pack";
import { createPaymentSchema } from "@/lib/orders/payment-validation";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { verifyPayments } from "@/lib/payments/queries";
import { prisma } from "@/lib/prisma";
import { completeConditionCheck } from "@/lib/returns/condition-check";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";
import { getWalletBalances, getWalletStatement } from "@/lib/wallets/ledger";

// Verify Phase 2 (BUILD_PROMPTS.md) — stock and money, end to end, against
// the mocked Steadfast client, inside rolled-back transactions on antu_test.
// Items 1, 4, 7, 8 and 9 of the owner's checklist; items 6 and 10 live in
// live-api-switch.test.ts and lib/auth/__tests__/money-routes.integration.test.ts.

const ADMIN = "01711000001";
const SE = "01711000004";
const PACKER = "01711000005";
const ACCOUNTS = "01711000006";

const sf = vi.mocked(steadfast);
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("A real network call was attempted during a Steadfast test");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => vi.resetAllMocks());

type Tx = Prisma.TransactionClient;

/** "YYYY-MM-DD HH:MM:SS" in Asia/Dhaka — the zone-less shape Steadfast sends. */
const dhakaStamp = (d = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);

function mockPayouts(payouts: Record<string, unknown>[], consignmentsByRef: Record<string, Record<string, unknown>[]>) {
  sf.getPayments.mockImplementation(async (_creds, page = 1) => ({ status: 1, payments: page === 1 ? payouts : [] }));
  sf.getPaymentDetail.mockImplementation(async (_creds, id) => {
    const payout = payouts.find((p) => String(p.payment_id).endsWith(id))!;
    return { payment: payout, consignments: consignmentsByRef[String(payout.payment_id)] ?? [] };
  });
}

async function scratchVariant(tx: Tx) {
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow({}), tx.color.findFirstOrThrow({})]);
  const tag = uniquePhone();
  const code = testProductCode();
  const product = await tx.product.create({ data: { code, name: `Verify P2 ${tag}`, basePrice: 1000 } });
  return tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: testSku(code) } });
}

/** The invariant, three ways: the running figure we expect, sum(ledger) = stock_qty, and the DB's own commit-time trigger. */
async function expectStock(tx: Tx, variantId: string, stockQty: number, reservedQty = 0) {
  const v = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  const ledger = await tx.stockMovement.aggregate({ where: { variantId }, _sum: { qty: true } });
  expect(ledger._sum.qty ?? 0).toBe(v.stockQty);
  expect(v.stockQty).toBe(stockQty);
  expect(v.reservedQty).toBe(reservedQty);
  await checkDeferredConstraintsNow(tx);
}

/** Courier cancels the parcel; the status API confirms it → RETURNED with a return inspection open. */
async function courierReturns(tx: Tx, orderId: string, cid: number, charge: number) {
  await sendOne(tx, orderId, cid, `T${cid}`);
  sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "cancelled", raw: {} });
  await webhook(tx, { notification_type: "delivery_status", consignment_id: cid, status: "cancelled", delivery_charge: charge });
  expect(await orderStatus(tx, orderId)).toBe("RETURNED");
  return tx.returnInspection.findFirstOrThrow({ where: { orderId } });
}

const balanceOf = async (tx: Tx, walletId: string) => toNumber((await getWalletBalances(tx, { walletId }))[0].balance);

/** Closing figure of the wallet's statement from its opening date to the end of today (Dhaka). */
async function statementClosing(tx: Tx, walletId: string) {
  const [w] = await getWalletBalances(tx, { walletId });
  const s = await getWalletStatement(tx, walletId, new Date(w.openingDate), dhakaDayStartUtc(todayInDhaka(), 1));
  return toNumber(s!.closingBalance);
}

const expenseIds = async (tx: Tx) => new Set((await tx.expense.findMany({ select: { id: true } })).map((e) => e.id));

// ---------------------------------------------------------------------------
// 1 + 2. Stock ledger
// ---------------------------------------------------------------------------

describe("1. sum(stock_movements) = stock_qty through every stock event", () => {
  it("purchase → sale → cancel after pack → courier return (good + damaged) → partial delivery", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor(ADMIN);
      const packer = await sessionUserFor(PACKER);
      const variant = await scratchVariant(tx);
      const supplier = await tx.supplier.create({ data: { name: `Verify supplier ${uniquePhone()}` } });
      await expectStock(tx, variant.id, 0);

      // Purchase 20 → PURCHASE_IN.
      await createPurchase(
        tx,
        { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_QTY", transportCost: 0, otherCost: 0, amountPaid: 0, items: [{ variantId: variant.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 20, unitCost: 400 }] },
        admin.id,
      );
      await expectStock(tx, variant.id, 20);

      // Sale of 2: reserved at CONFIRMED, SALE_OUT at PACKED.
      await makePackedOrder(tx, { variantIds: [variant.id], qty: 2 });
      await expectStock(tx, variant.id, 18);

      // Cancel after pack: RETURN_IN at the frozen cost.
      const cancelled = await makePackedOrder(tx, { variantIds: [variant.id], qty: 1 });
      await expectStock(tx, variant.id, 17);
      await moveOrderStatus(tx, { id: cancelled.order.id, status: "PACKED", items: [] }, "CANCELLED", admin.id);
      await expectStock(tx, variant.id, 18);

      // Courier return of 2: RETURNED alone moves nothing; the condition check does.
      const returned = await makePackedOrder(tx, { variantIds: [variant.id], qty: 2 });
      await expectStock(tx, variant.id, 16);
      const inspection = await courierReturns(tx, returned.order.id, 7_710_001, 75);
      await expectStock(tx, variant.id, 16);
      const [returnedItem] = await tx.orderItem.findMany({ where: { orderId: returned.order.id } });
      await completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: returnedItem.id, goodQty: 1, damagedQty: 1 }] }, packer.id);
      await expectStock(tx, variant.id, 17); // +1 good, +1 damaged, −1 written off
      const damage = await tx.stockMovement.findFirstOrThrow({ where: { variantId: variant.id, type: "DAMAGE_OUT" } });
      const damageExpense = await tx.expense.findFirstOrThrow({ where: { stockMovementId: damage.id }, include: { category: true } });
      expect(damageExpense.category).toMatchObject({ id: WRITE_OFF_EXPENSE_CATEGORY_ID, name: "Damage / write-off", kind: "DAMAGE_WRITE_OFF" });
      expect(toNumber(damageExpense.amount)).toBe(toNumber(returnedItem.unitCostSnapshot!));

      // Partial delivery of 3, customer keeps 2: the 1 back is restocked only after its check.
      const partial = await makePackedOrder(tx, { variantIds: [variant.id], qty: 3 });
      await expectStock(tx, variant.id, 14);
      await sendOne(tx, partial.order.id, 7_710_002, "T7710002");
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 7_710_002, status: "pending" });
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "partial_delivered", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 7_710_002, status: "partial_delivered", cod_amount: 2060 });
      expect(await orderStatus(tx, partial.order.id)).toBe("PARTIAL_DELIVERED");
      const partialInspection = await tx.returnInspection.findFirstOrThrow({ where: { orderId: partial.order.id } });
      const [partialItem] = await tx.orderItem.findMany({ where: { orderId: partial.order.id } });
      await markKeptItems(tx, { inspectionId: partialInspection.id, kept: [{ orderItemId: partialItem.id, keptQty: 2 }] }, packer.id);
      await expectStock(tx, variant.id, 14);
      await completeConditionCheck(tx, { inspectionId: partialInspection.id, lines: [{ orderItemId: partialItem.id, goodQty: 1, damagedQty: 0 }] }, packer.id);
      await expectStock(tx, variant.id, 15);

      const ledger = await tx.stockMovement.findMany({ where: { variantId: variant.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      expect(ledger.map((m) => [m.type, m.qty])).toEqual([
        ["PURCHASE_IN", 20],
        ["SALE_OUT", -2],
        ["SALE_OUT", -1],
        ["RETURN_IN", 1],
        ["SALE_OUT", -2],
        ["RETURN_IN", 1], // the good unit
        ["RETURN_IN", 1], // the damaged unit comes back into our hands…
        ["DAMAGE_OUT", -1], // …and is written off
        ["SALE_OUT", -3],
        ["RETURN_IN", 1],
      ]);
      let running = 0;
      for (const m of ledger) expect(m.stockAfter).toBe((running += m.qty));
    });
  }, 180_000);
});

describe("2. no path changes stock without its ledger row — or twice", () => {
  it("a stale status can't move an order: a second pack or a late cancel rolls back with nothing written", async () => {
    await inRolledBackTransaction(async (tx) => {
      const admin = await sessionUserFor(ADMIN);
      const packer = await sessionUserFor(PACKER);
      const variant = await scratchVariant(tx);
      const supplier = await tx.supplier.create({ data: { name: `Verify supplier ${uniquePhone()}` } });
      await createPurchase(tx, { supplierId: supplier.id, purchaseDate: new Date(), allocationMethod: "BY_QTY", transportCost: 0, otherCost: 0, amountPaid: 0, items: [{ variantId: variant.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 5, unitCost: 300 }] }, admin.id);
      const { order } = await makePackedOrder(tx, { variantIds: [variant.id], qty: 1 });
      await expectStock(tx, variant.id, 4);
      const items = await tx.orderItem.findMany({ where: { orderId: order.id } });

      // Two packers on one order: the second read CONFIRMED before the first committed.
      await tx.$executeRaw`SAVEPOINT second_pack`;
      await expect(packOrder(tx, { id: order.id, status: "CONFIRMED", items: items.map((i) => ({ id: i.id, variantId: i.variantId, qty: i.qty })) }, packer.id)).rejects.toBeInstanceOf(StaleOrderStatusError);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT second_pack`; // what the route's $transaction does
      await expectStock(tx, variant.id, 4);
      expect(await tx.stockMovement.count({ where: { referenceId: order.id, type: "SALE_OUT" } })).toBe(1);

      // A cancel that read CONFIRMED (would only release a reservation) after the order was packed.
      await expect(moveOrderStatus(tx, { id: order.id, status: "CONFIRMED", items: [] }, "CANCELLED", admin.id)).rejects.toBeInstanceOf(StaleOrderStatusError);
      expect(await orderStatus(tx, order.id)).toBe("PACKED");
      await expectStock(tx, variant.id, 4);
    });
  }, 120_000);

  it("an order past CONFIRMED can't be edited — not directly, and not by approving an old edit request", async () => {
    const admin = await sessionUserFor(ADMIN);
    const packed = await prisma.order.findFirstOrThrow({ where: { status: { notIn: ["LEAD", "CONFIRMED"] }, deletedAt: null, items: { some: {} } }, include: { items: true } });
    const validation = await validateOrderEdit(packed.id, { internalNote: "late edit" }, admin);
    expect(validation).toMatchObject({ ok: false, status: 409 });

    // Even a validation obtained earlier (the request sat PENDING while the order was packed) is refused inside the write.
    const stale = { ok: true as const, validatedItems: [], validatedSets: [], effectiveDeliveryCharge: 0, subtotal: 0, discountTotal: 0, total: 0, dueAmount: 0 };
    await expect(applyValidatedOrderEdit(packed.id, { items: [] }, stale)).rejects.toBeInstanceOf(OrderEditConflictError);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: packed.id }, include: { items: true } });
    expect(after.items.map((i) => [i.id, i.qty, i.unitCostSnapshot?.toString()])).toEqual(packed.items.map((i) => [i.id, i.qty, i.unitCostSnapshot?.toString()]));
    expect(after.total.toString()).toBe(packed.total.toString());
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. transaction_id uniqueness in the database
// ---------------------------------------------------------------------------

describe("4. payments.transaction_id is unique at the database level", () => {
  it("a unique index refuses a reused TrxID, and a CHECK makes it case- and space-insensitive", async () => {
    const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT "indexdef" FROM pg_indexes WHERE "indexname" = 'payments_transactionId_key'`;
    expect(index.indexdef).toMatch(/^CREATE UNIQUE INDEX .* ON public\.payments USING btree \("transactionId"\)$/);

    await inRolledBackTransaction(async (tx) => {
      const se = await sessionUserFor(SE);
      const order = await tx.order.findFirstOrThrow({ where: { deletedAt: null } });
      const base = { orderId: order.id, amount: 10, method: "BKASH" as const, walletId: "wallet_bkash_personal", receivedById: se.id };
      await tx.payment.create({ data: { ...base, transactionId: "VFY8N7A6B5C" } });

      await tx.$executeRaw`SAVEPOINT dup`;
      await expect(tx.payment.create({ data: { ...base, transactionId: "VFY8N7A6B5C" } })).rejects.toMatchObject({ code: "P2002" });
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT dup`;

      // Bypassing the app's normalizing schema: the database still refuses the lower-case twin.
      await tx.$executeRaw`SAVEPOINT lower`;
      await expect(tx.payment.create({ data: { ...base, transactionId: "vfy8n7a6b5c" } })).rejects.toThrow(/payments_transaction_id_normalized_chk/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT lower`;

      // Blank isn't an ID either; many NULLs are fine.
      await tx.$executeRaw`SAVEPOINT blank`;
      await expect(tx.payment.create({ data: { ...base, transactionId: "  " } })).rejects.toThrow(/payments_transaction_id_normalized_chk/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT blank`;
      await tx.payment.create({ data: { ...base, transactionId: null } });
      await tx.payment.create({ data: { ...base, transactionId: null } });
    });

    // What the routes store: trimmed and upper-cased.
    expect(createPaymentSchema.parse({ amount: 1, method: "BKASH", transactionId: " 8n7a6b5c " }).transactionId).toBe("8N7A6B5C");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 7 + 8 + 9. Money round trip, replay, mismatch, wallets
// ---------------------------------------------------------------------------

describe("7. money round trip: advance + COD → packed → sent → delivered → payout → COMPLETED", () => {
  it("due is 0, the bank wallet moves by exactly the net payout, each courier charge is expensed once, and a replay changes nothing", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor(ADMIN);
      const accounts = await sessionUserFor(ACCOUNTS);
      const se = await sessionUserFor(SE);
      const bankId = (await defaultCourierPayoutWalletId(tx))!;
      const bkashId = "wallet_bkash_personal";
      const before = { bank: await balanceOf(tx, bankId), bkash: await balanceOf(tx, bkashId), expenses: await expenseIds(tx) };

      // Advance of ৳500 by bKash, taken before packing; Accounts verifies it.
      let advanceId = "";
      const { order } = await makePackedOrder(tx, {
        beforePack: async (t, o) => {
          const p = await t.payment.create({ data: { orderId: o.id, amount: 500, method: "BKASH", walletId: bkashId, transactionId: `ADV${uniquePhone()}`, receivedById: se.id } });
          advanceId = p.id;
          await recomputeOrderDueAmount(t, o.id);
        },
      });
      expect(await balanceOf(tx, bkashId)).toBe(before.bkash); // unverified = pending, not balance
      expect(await verifyPayments(tx, accounts, [advanceId])).toBe(1);
      expect(await balanceOf(tx, bkashId)).toBe(before.bkash + 500);

      const total = toNumber(order.total);
      const cid = 7_720_001;
      await sendOne(tx, order.id, cid, `T${cid}`);
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      const cod = toNumber(shipment.codAmount);
      expect(cod).toBe(total - 500); // the rider collects only what's still due

      await webhook(tx, { notification_type: "delivery_status", consignment_id: cid, status: "pending" });
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: cid, status: "delivered", delivery_charge: 60 });
      expect(await orderStatus(tx, order.id)).toBe("DELIVERED");

      const fee = Math.round((cod - 60) * 0.01);
      const net = cod - 60 - fee;
      mockPayouts(
        [{ payment_id: "SFC-77200001", amount: cod, due_bills: 60, charges: fee, total: net, status_label: "paid", paid_at: dhakaStamp() }],
        { "SFC-77200001": [{ consignment_id: cid, invoice: order.orderNo, cod_amount: cod, status: "delivered" }] },
      );
      expect(await runSteadfastPayoutsSync(tx, { actorId: admin.id, delayMs: 0 })).toMatchObject({ settled: 1, completed: 1, discrepancies: 0, errors: [] });

      // Order: fully paid, COMPLETED.
      const done = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
      expect(done.status).toBe("COMPLETED");
      expect(toNumber(done.dueAmount)).toBe(0);
      const byMethod = done.payments.map((p) => [p.method, toNumber(p.amount), p.verified, p.walletId]).sort();
      expect(byMethod).toEqual([["BKASH", 500, true, bkashId], ["COURIER_COD", cod, true, null]]);
      expect(done.payments.reduce((s, p) => s + toNumber(p.amount), 0)).toBe(total);

      // Wallets: the bank moved by exactly the net payout; bKash by the advance; nothing else.
      expect(await balanceOf(tx, bankId)).toBeCloseTo(before.bank + net, 2);
      expect(await balanceOf(tx, bkashId)).toBe(before.bkash + 500);

      // Expenses: exactly the two courier charges, once each, from no wallet (the courier deducted them).
      // P3.3: plus, at most, the one "Packaging used" posting packing made — its own heading, not a courier charge.
      const all = await tx.expense.findMany({ where: { id: { notIn: [...before.expenses] } }, include: { category: true } });
      expect(all.filter((e) => e.category.kind === "PACKAGING").map((e) => e.packagingOrderId)).toEqual(all.some((e) => e.category.kind === "PACKAGING") ? [order.id] : []);
      const created = all.filter((e) => e.category.kind !== "PACKAGING");
      expect(created.map((e) => [e.category.name, e.category.kind, toNumber(e.amount), e.walletId]).sort()).toEqual([
        ["COD charge", "COURIER", fee, null],
        ["Courier delivery charge", "COURIER", 60, null],
      ]);
      // P&L rule: the parcel's courier cost reaches P&L once — through these expenses. The
      // shipment's own courier cost (per-order profit) is a field, never an expense row.
      expect(toNumber((await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).courierCostActual!)).toBe(60);
      expect(created.reduce((s, e) => s + toNumber(e.amount), 0)).toBe(60 + fee);

      // 9. Balance = statement closing, for both wallets.
      expect(await statementClosing(tx, bankId)).toBeCloseTo(await balanceOf(tx, bankId), 2);
      expect(await statementClosing(tx, bkashId)).toBeCloseTo(await balanceOf(tx, bkashId), 2);

      // 8. Replay the same payout: nothing new anywhere.
      const snapshot = { payments: await tx.payment.count(), expenses: await tx.expense.count(), bank: await balanceOf(tx, bankId) };
      expect(await runSteadfastPayoutsSync(tx, { actorId: admin.id, delayMs: 0 })).toMatchObject({ created: 0, settled: 0 });
      const courierId = (await tx.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } })).id;
      await ingestCourierStatement(tx, { courierId, source: "STEADFAST_API", reference: "SFC-77200001", status: "PAID", statementDate: new Date(), grossAmount: cod, deliveryCharge: 60, codCharge: fee, netAmount: net, lines: [{ consignmentId: String(cid), codAmount: cod }] }, admin.id);
      expect(await tx.payment.count()).toBe(snapshot.payments);
      expect(await tx.expense.count()).toBe(snapshot.expenses);
      expect(await balanceOf(tx, bankId)).toBe(snapshot.bank);
      expect(await tx.courierStatement.count({ where: { reference: "SFC-77200001" } })).toBe(1);
      await checkDeferredConstraintsNow(tx);
    });
  }, 180_000);
});

describe("8. a mismatched payout moves no order money", () => {
  it("short COD → MISMATCH: no payment, due and status untouched, no expense; only the cash the courier really paid lands in the bank", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const bankId = (await defaultCourierPayoutWalletId(tx))!;
      const { order } = await makePackedOrder(tx);
      const cid = 7_730_001;
      await sendOne(tx, order.id, cid, `T${cid}`);
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: cid, status: "delivered", delivery_charge: 60 });
      const due = toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount);
      const before = { bank: await balanceOf(tx, bankId), expenses: await tx.expense.count() };

      const short = due - 100;
      mockPayouts(
        [{ payment_id: "SFC-77300001", amount: short, due_bills: 60, charges: 10, total: short - 70, status_label: "paid", paid_at: dhakaStamp() }],
        { "SFC-77300001": [{ consignment_id: cid, invoice: order.orderNo, cod_amount: short, status: "delivered" }] },
      );
      expect(await runSteadfastPayoutsSync(tx, { delayMs: 0 })).toMatchObject({ settled: 0, discrepancies: 1 });

      const after = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe("DELIVERED");
      expect(toNumber(after.dueAmount)).toBe(due);
      expect(await tx.payment.count({ where: { orderId: order.id, method: "COURIER_COD" } })).toBe(0);
      expect(await tx.expense.count()).toBe(before.expenses);
      const statement = await tx.courierStatement.findFirstOrThrow({ where: { reference: "SFC-77300001" } });
      expect(statement.reconciledAt).toBeNull();
      // The courier did deposit this net into the bank, so the bank wallet shows it — it mirrors the real account.
      expect(await balanceOf(tx, bankId)).toBeCloseTo(before.bank + short - 70, 2);
      expect(await statementClosing(tx, bankId)).toBeCloseTo(await balanceOf(tx, bankId), 2);
    });
  }, 120_000);
});

describe("P&L rule: a courier return charge reaches expenses exactly once, whichever comes first", () => {
  it("payout reconciled BEFORE the condition check: the statement carries the charge, the check posts none", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor(ADMIN);
      const packer = await sessionUserFor(PACKER);
      const { order } = await makePackedOrder(tx);
      const cid = 7_740_001;
      const inspection = await courierReturns(tx, order.id, cid, 75);
      const before = await expenseIds(tx);

      const courierId = (await tx.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } })).id;
      const outcome = await ingestCourierStatement(
        tx,
        { courierId, source: "MANUAL", reference: "VFY-RET-FIRST", status: "PAID", statementDate: new Date(), lines: [{ consignmentId: String(cid), codAmount: 0, deliveryCharge: 75 }] },
        admin.id,
      );
      expect(outcome).toMatchObject({ settled: 1, reconciledNow: true });

      const [item] = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const check = await completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: item.id, goodQty: item.qty, damagedQty: 0 }] }, packer.id);
      expect(check.returnChargePosted).toBeNull();

      const created = await tx.expense.findMany({ where: { id: { notIn: [...before] } }, include: { category: true } });
      expect(created.map((e) => [e.category.name, toNumber(e.amount)])).toEqual([["Courier delivery charge", 75]]);
    });
  }, 120_000);
});

describe("9. wallet balances are derived, and always equal the statement's closing figure", () => {
  it("no stored balance column exists on wallets", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT "column_name" FROM information_schema.columns WHERE "table_schema" = 'public' AND "table_name" = 'wallets'`;
    expect(cols.map((c) => c.column_name).filter((c) => /balance/i.test(c))).toEqual(["openingBalance"]);
  });

  it("for every wallet in the database: balance = closing of its statement (all history, and this month so far)", async () => {
    const wallets = await getWalletBalances(prisma);
    expect(wallets.length).toBeGreaterThan(0);
    const monthStart = dhakaDayStartUtc(`${todayInDhaka().slice(0, 7)}-01`);
    const endOfToday = dhakaDayStartUtc(todayInDhaka(), 1);
    for (const w of wallets) {
      const all = await getWalletStatement(prisma, w.id, new Date(w.openingDate), endOfToday);
      const month = await getWalletStatement(prisma, w.id, monthStart, endOfToday);
      expect(all!.closingBalance, w.name).toBe(w.balance);
      expect(month!.closingBalance, `${w.name} (this month)`).toBe(w.balance);
    }
  }, 60_000);

  it("money can't be dated in the future (it would sit in the balance before it happened)", async () => {
    const tomorrow = new Date(dhakaDayStartUtc(todayInDhaka(), 1).getTime() + 60_000);
    expect(createPaymentSchema.safeParse({ amount: 1, method: "CASH", paidAt: tomorrow }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ amount: 1, method: "CASH", paidAt: new Date() }).success).toBe(true);
  });
});
