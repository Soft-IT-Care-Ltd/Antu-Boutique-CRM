import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { ROLE_TEMPLATES } from "@/lib/auth/permission-definitions";
import { recordStockMovement } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { toNumber } from "@/lib/money";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { packOrder } from "@/lib/orders/pack";
import { refundableAmount } from "@/lib/payments/refunds";
import { createPosSale } from "@/lib/pos/sale";
import { getCollectionReport } from "@/lib/reports/finance";
import { completeConditionCheck } from "@/lib/returns/condition-check";
import { createCounterExchange, decideReturnCase, requestReturnCase } from "@/lib/returns/cases";
import { STORE_CREDIT_EXPIRY_SETTING_KEY } from "@/lib/store-credit/constants";
import { adjustStoreCredit, getStoreCredit, getStoreCreditBalance, getStoreCreditPosition, spendStoreCredit, StoreCreditError } from "@/lib/store-credit/ledger";
import { deliveredOrder, freshPhone, PHONES, scratchCatalog, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// P3.2 — store credit (PRD §4.11, §4.12): issued at the counter instead of a
// refund, a ledger per customer with the balance always derived, spent at
// the POS and on online orders, given back on cancel, adjusted only by an
// Admin, optional expiry, and a liability in the collection report.

const TIMEOUT = 120_000;

async function cashWallet(tx: Prisma.TransactionClient) {
  return (await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } })).id;
}

/** A counter exchange of one unit for the ৳900 product: ৳1,350 back, ৳450 to credit. */
async function cheaperCounterSwap(tx: Prisma.TransactionClient, orderId: string, orderItemId: string, cheaperId: string, customer?: { phone: string; name?: string }) {
  const pos = await userFor(tx, PHONES.POS);
  return createCounterExchange(tx, { user: pos, cashWalletId: await cashWallet(tx), canCreateCustomer: true }, {
    orderId,
    reason: "NOT_AS_EXPECTED",
    lines: [{ orderItemId, qty: 1, replacementVariantId: cheaperId, goodQty: 1, damagedQty: 0 }],
    tenders: [],
    customer: customer ?? null,
  });
}

/** An anonymous showroom sale of one unit at ৳1,450, paid by card. */
/** C3 — the counter sells from the Shyamoli showroom's shelf, so the item has to be there. */
async function stockShowroom(tx: Prisma.TransactionClient, variantId: string, qty: number) {
  await recordStockMovement(tx, { variantId, locationId: SEEDED_LOCATION_IDS.shyamoli, type: "PURCHASE_IN", qty, unitCost: 400, referenceType: "OPENING_BALANCE", actorId: null });
}

async function anonymousSale(tx: Prisma.TransactionClient, variantId: string) {
  await stockShowroom(tx, variantId, 1);
  const pos = await userFor(tx, PHONES.POS);
  return createPosSale(tx, { user: pos, cashWalletId: await cashWallet(tx), hasCostAccess: false, canCreateCustomer: true }, {
    items: [{ variantId, qty: 1, unitPrice: 1450, lineDiscount: 0 }],
    cartDiscount: 0,
    customer: null,
    tenders: [{ method: "CARD", amount: 1450 }],
  });
}

describe("store credit at the counter (PRD §4.11)", () => {
  it(
    "a cheaper replacement credits the customer at once: a ledger row with order, case, user and time; the balance is derived",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const pos = await userFor(tx, PHONES.POS);
        const result = await cheaperCounterSwap(tx, order.id, order.items[0].id, catalog.cheaper.id);

        expect(result.storeCreditIssued).toBe("450.00");
        const entries = await tx.storeCreditEntry.findMany({ where: { customerId: order.customerId! } });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ type: "ISSUED", orderId: order.id, returnCaseId: result.caseId, createdById: pos.id, expiresAt: null });
        expect(toNumber(entries[0].amount)).toBe(450);
        // No money moved: the credit's payment row has no wallet, and no refund exists.
        const creditPayment = await tx.payment.findUniqueOrThrow({ where: { id: entries[0].paymentId! } });
        expect(creditPayment).toMatchObject({ kind: "STORE_CREDIT", method: "STORE_CREDIT", walletId: null, orderId: order.id });
        expect(toNumber(creditPayment.amount)).toBe(-450);
        expect(await tx.payment.count({ where: { orderId: order.id, kind: "REFUND" } })).toBe(0);
        // The original is settled. The credit left it, so it can't be refunded
        // as cash too: only the ৳80 delivery the customer still paid for is left.
        const original = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(toNumber(original.dueAmount)).toBe(0);
        expect(toNumber(original.total)).toBe(80);
        expect(await refundableAmount(tx, order.id)).toBe(80);
        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("450.00");
        await checkDeferredConstraintsNow(tx);
      });
    },
    TIMEOUT,
  );

  it(
    "an anonymous sale needs a phone number before credit is issued; the number links both orders to the customer",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const sale = await anonymousSale(tx, catalog.m.id);
        const item = await tx.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } });

        await expect(cheaperCounterSwap(tx, sale.orderId, item.id, catalog.cheaper.id)).rejects.toThrow(/phone number so it can go to their store credit/);

        const phone = freshPhone();
        const result = await cheaperCounterSwap(tx, sale.orderId, item.id, catalog.cheaper.id, { phone, name: "Counter Credit" });
        // 1,450 back, 900 out → 550 to credit.
        expect(result.storeCreditIssued).toBe("550.00");
        const customer = await tx.customer.findUniqueOrThrow({ where: { phone } });
        const [original, replacement] = await Promise.all([
          tx.order.findUniqueOrThrow({ where: { id: sale.orderId } }),
          tx.order.findUniqueOrThrow({ where: { id: result.replacementOrderId } }),
        ]);
        expect(original.customerId).toBe(customer.id);
        expect(replacement.customerId).toBe(customer.id);
        expect(await getStoreCreditBalance(tx, customer.id)).toBe("550.00");
      });
    },
    TIMEOUT,
  );
});

describe("spending store credit", () => {
  it(
    "pays at the POS by phone number, never more than the balance, and is not money collected",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        await cheaperCounterSwap(tx, order.id, order.items[0].id, catalog.cheaper.id);
        const phone = (await tx.customer.findUniqueOrThrow({ where: { id: order.customerId! } })).phone;
        const pos = await userFor(tx, PHONES.POS);
        const ctx = { user: pos, cashWalletId: await cashWallet(tx), hasCostAccess: false, canCreateCustomer: true };
        const item = { variantId: catalog.cheaper.id, qty: 1, unitPrice: 900, lineDiscount: 0 };
        await stockShowroom(tx, catalog.cheaper.id, 3);

        await expect(createPosSale(tx, ctx, { items: [item], cartDiscount: 0, customer: null, tenders: [{ method: "STORE_CREDIT", amount: 450 }, { method: "CARD", amount: 450 }] })).rejects.toThrow(
          /phone number to pay with their store credit/,
        );
        await expect(createPosSale(tx, ctx, { items: [item], cartDiscount: 0, customer: { phone }, tenders: [{ method: "STORE_CREDIT", amount: 600 }, { method: "CARD", amount: 300 }] })).rejects.toThrow(
          /only ৳\s?450/,
        );

        const report = async () => getCollectionReport(tx, await userFor(tx, PHONES.ADMIN), new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
        const before = await report();
        const sale = await createPosSale(tx, ctx, { items: [item], cartDiscount: 0, customer: { phone }, tenders: [{ method: "STORE_CREDIT", amount: 450 }, { method: "CARD", amount: 450 }] });
        const after = await report();

        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("0.00");
        const used = await tx.storeCreditEntry.findFirstOrThrow({ where: { customerId: order.customerId!, type: "USED" } });
        expect(used).toMatchObject({ orderId: sale.orderId, createdById: pos.id });
        expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: sale.orderId } })).dueAmount)).toBe(0);
        // Only the card's 450 is money collected; the credit is a liability paid off.
        expect(toNumber(after.totals.collected) - toNumber(before.totals.collected)).toBe(450);
        expect(toNumber(after.storeCredit.used) - toNumber(before.storeCredit.used)).toBe(450);
        expect(toNumber(after.storeCredit.outstanding) - toNumber(before.storeCredit.outstanding)).toBe(-450);
      });
    },
    TIMEOUT,
  );

  it(
    "credit spent on an online order goes back to the customer when the order is cancelled — never as cash",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        await cheaperCounterSwap(tx, order.id, order.items[0].id, catalog.cheaper.id);
        const se = await userFor(tx, PHONES.SE);
        const next = await tx.order.create({
          data: { orderNo: `TEST-SC-${Date.now()}`, channel: "ONLINE", status: "CONFIRMED", customerId: order.customerId, subtotal: 900, discountTotal: 0, total: 900, dueAmount: 900, createdById: se.id, teamId: se.teamId },
        });
        await spendStoreCredit(tx, { customerId: order.customerId!, orderId: next.id, amountPaisa: 30_000, actorId: se.id });
        expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: next.id } })).dueAmount)).toBe(600);
        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("150.00");
        expect(await refundableAmount(tx, next.id)).toBe(0);

        await moveOrderStatus(tx, { id: next.id, status: "CONFIRMED", items: [] }, "CANCELLED", se.id, "Customer changed their mind");
        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("450.00");
        const restored = await tx.storeCreditEntry.findFirstOrThrow({ where: { orderId: next.id, type: "RESTORED" } });
        expect(toNumber(restored.amount)).toBe(300);
        await checkDeferredConstraintsNow(tx);
      });
    },
    TIMEOUT,
  );
});

describe("online exchanges and returns settled as store credit", () => {
  it(
    "an online exchange for something cheaper credits the difference only once the item is back and checked",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const [se, tl, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.TL), userFor(tx, PHONES.PACKING)]);
        const { id: caseId } = await requestReturnCase(tx, se, {
          orderId: order.id,
          type: "EXCHANGE",
          reason: "NOT_AS_EXPECTED",
          courierChargeBearer: "COMPANY",
          settlement: "STORE_CREDIT",
          lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.cheaper.id }],
        });
        const decision = await decideReturnCase(tx, tl, caseId, { decision: "APPROVE" });
        expect(decision).toMatchObject({ owedToCustomer: "450.00", settlement: "STORE_CREDIT" });
        // Nothing yet: the item hasn't come back.
        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("0.00");

        const replacement = await tx.order.findUniqueOrThrow({ where: { id: decision!.replacementOrderId! }, include: { items: true } });
        await packOrder(tx, { id: replacement.id, status: "CONFIRMED", items: replacement.items }, packer.id);
        const rc = await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } });
        await completeConditionCheck(tx, { inspectionId: rc.inspectionId!, lines: [{ orderItemId: order.items[0].id, goodQty: 1, damagedQty: 0 }] }, packer.id);

        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("450.00");
        expect(await tx.storeCreditEntry.count({ where: { returnCaseId: caseId, type: "ISSUED" } })).toBe(1);
        expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount)).toBe(0);
      });
    },
    TIMEOUT,
  );

  it(
    "a return settled as store credit credits what came back and makes the order REFUNDED",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const [se, tl, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.TL), userFor(tx, PHONES.PACKING)]);
        const { id: caseId } = await requestReturnCase(tx, se, { orderId: order.id, type: "RETURN", reason: "NOT_AS_EXPECTED", settlement: "STORE_CREDIT", lines: [{ orderItemId: order.items[0].id, qty: 1 }] });
        await decideReturnCase(tx, tl, caseId, { decision: "APPROVE" });
        const rc = await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } });
        await completeConditionCheck(tx, { inspectionId: rc.inspectionId!, lines: [{ orderItemId: order.items[0].id, goodQty: 1, damagedQty: 0 }] }, packer.id);

        const after = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(after.status).toBe("REFUNDED");
        expect(toNumber(after.dueAmount)).toBe(0);
        // 1,450 − 100 came back.
        expect(await getStoreCreditBalance(tx, order.customerId!)).toBe("1350.00");
      });
    },
    TIMEOUT,
  );
});

describe("adjustments and expiry", () => {
  it(
    "only an Admin can adjust, with a reason; a deduction can't go below zero; every adjustment is audited",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        expect(ROLE_TEMPLATES.ADMIN).toContain("customer.credit.adjust");
        for (const role of ["MANAGER", "TEAM_LEADER", "SALES_EXECUTIVE", "PACKING", "ACCOUNTS", "POS_OPERATOR"] as const) {
          expect(ROLE_TEMPLATES[role], role).not.toContain("customer.credit.adjust");
        }
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const admin = await userFor(tx, PHONES.ADMIN);
        const customerId = order.customerId!;

        await adjustStoreCredit(tx, { customerId, amount: 200, reason: "Goodwill — late delivery", actorId: admin.id });
        await expect(adjustStoreCredit(tx, { customerId, amount: -300, reason: "Correction", actorId: admin.id })).rejects.toThrow(StoreCreditError);
        await expect(adjustStoreCredit(tx, { customerId, amount: 50, reason: " ", actorId: admin.id })).rejects.toThrow(/reason/);
        await adjustStoreCredit(tx, { customerId, amount: -50, reason: "Correction", actorId: admin.id });

        expect(await getStoreCreditBalance(tx, customerId)).toBe("150.00");
        const audits = await tx.auditLog.findMany({ where: { entityType: "customer", entityId: customerId, action: "store_credit.adjust" } });
        expect(audits).toHaveLength(2);
        expect(audits.every((a) => a.actorId === admin.id)).toBe(true);
        // The database holds the reason rule too.
        await expect(tx.$executeRaw`INSERT INTO "store_credit_entries" ("id", "customerId", "type", "amount") VALUES ('sc_no_reason', ${customerId}, 'ADJUSTED', 10)`).rejects.toThrow();
      });
    },
    TIMEOUT,
  );

  it(
    "with an expiry set, unspent credit lapses and shows as expired, not outstanding",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        await tx.setting.upsert({ where: { key: STORE_CREDIT_EXPIRY_SETTING_KEY }, update: { value: "30" }, create: { key: STORE_CREDIT_EXPIRY_SETTING_KEY, value: "30" } });
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        await cheaperCounterSwap(tx, order.id, order.items[0].id, catalog.cheaper.id);
        const entry = await tx.storeCreditEntry.findFirstOrThrow({ where: { customerId: order.customerId!, type: "ISSUED" } });
        expect(entry.expiresAt).not.toBeNull();
        const days = (entry.expiresAt!.getTime() - entry.createdAt.getTime()) / 86_400_000;
        expect(days).toBe(30);

        const later = new Date(entry.createdAt.getTime() + 31 * 86_400_000);
        expect((await getStoreCredit(tx, order.customerId!, later)).balancePaisa).toBe(0);
        const position = await getStoreCreditPosition(tx, new Date(entry.createdAt.getTime() + 86_400_000), later);
        expect(toNumber(position.expired)).toBeGreaterThanOrEqual(450);
      });
    },
    TIMEOUT,
  );
});
