import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers call auth(); next-auth can't load under plain Node, so the
// session is whatever the test says it is.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { GET as reportGET } from "@/app/api/returns/report/route";
import { GET as listGET, POST as requestPOST } from "@/app/api/returns/route";
import { finalizeStatement } from "@/lib/courier/reconcile";
import { getDayAllocation } from "@/lib/expenses/ad-allocation";
import { deleteExpense, ExpenseError, updateExpense } from "@/lib/expenses/service";
import { todayInDhaka } from "@/lib/inventory/constants";
import { toNumber } from "@/lib/money";
import { decideRefund } from "@/lib/payments/refunds";
import { cancelReturnCase, createCounterExchange, decideReturnCase, requestReturnCase, ReturnCaseError } from "@/lib/returns/cases";
import { EXCHANGE_COURIER_EXPENSE_CATEGORY_ID } from "@/lib/returns/constants";
import { postExchangeCourierCost } from "@/lib/returns/exchange-courier-cost";
import { listReturnCases } from "@/lib/returns/queries";
import { deliveredOrder, PHONES, runCounterExchange, runOnlineExchange, runReturnWithDamage, scratchCatalog, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// P3.2 — returns and exchanges (PRD §4.11). Service tests run in a
// rolled-back transaction on antu_test.

const TIMEOUT = 120_000;

beforeEach(() => {
  session.current = null;
});

async function ledgerMatches(tx: Prisma.TransactionClient, variantIds: string[]) {
  for (const variantId of variantIds) {
    const [variant, agg] = await Promise.all([tx.productVariant.findUniqueOrThrow({ where: { id: variantId } }), tx.stockMovement.aggregate({ where: { variantId }, _sum: { qty: true } })]);
    expect(agg._sum.qty ?? 0, variant.sku).toBe(variant.stockQty);
  }
  await checkDeferredConstraintsNow(tx);
}

const movements = (tx: Prisma.TransactionClient, variantId: string) => tx.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: "asc" }, select: { type: true, qty: true, unitCostSnapshot: true } });

describe("online exchange (PRD §4.11 A)", () => {
  it(
    "stays PENDING with no stock movement until the item is back; the replacement ships as EXCHANGE_OUT; the check restocks as EXCHANGE_IN",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const [se, tl, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.TL), userFor(tx, PHONES.PACKING)]);

        const { id: caseId } = await requestReturnCase(tx, se, {
          orderId: order.id,
          type: "EXCHANGE",
          reason: "WRONG_SIZE",
          courierChargeBearer: "CUSTOMER",
          lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.l.id }],
        });
        // Nobody approves their own request.
        await expect(decideReturnCase(tx, se, caseId, { decision: "APPROVE" })).rejects.toThrow(/someone other than who requested/);

        const beforeApprove = await movements(tx, catalog.m.id);
        const decision = await decideReturnCase(tx, tl, caseId, { decision: "APPROVE" });
        const replacement = await tx.order.findUniqueOrThrow({ where: { id: decision!.replacementOrderId! }, include: { items: true, payments: true } });

        // Linked, CONFIRMED, reserved — nothing has moved on the shelf yet.
        expect(replacement.exchangedFromOrderId).toBe(order.id);
        expect(replacement.status).toBe("CONFIRMED");
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: catalog.l.id } })).reservedQty).toBe(1);
        expect(await movements(tx, catalog.m.id)).toEqual(beforeApprove);
        const original = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
        expect(original.status).toBe("EXCHANGE_REQUESTED");
        expect(original.items[0].returnedQty).toBe(1);

        // Same product, another size: the customer paid 1,350 for it and pays
        // nothing more for the swap — only the ৳80 delivery they bear.
        expect(toNumber(replacement.items[0].unitPrice)).toBe(1450);
        expect(toNumber(replacement.items[0].lineDiscount)).toBe(100);
        expect(toNumber(replacement.total)).toBe(1430);
        expect(toNumber(replacement.dueAmount)).toBe(80);
        expect(toNumber(original.total)).toBe(80);
        expect(toNumber(original.dueAmount)).toBe(0);
        const credit = await tx.payment.findMany({ where: { returnCaseId: caseId, kind: "EXCHANGE_CREDIT" }, orderBy: { amount: "asc" } });
        expect(credit.map((c) => [c.orderId, toNumber(c.amount)])).toEqual([
          [order.id, -1350],
          [replacement.id, 1350],
        ]);
        expect(credit.every((c) => c.walletId === null && c.verified)).toBe(true);

        // The replacement goes out through normal packing, as EXCHANGE_OUT.
        const { packOrder } = await import("@/lib/orders/pack");
        await packOrder(tx, { id: replacement.id, status: "CONFIRMED", items: replacement.items }, packer.id);
        expect((await movements(tx, catalog.l.id)).at(-1)).toMatchObject({ type: "EXCHANGE_OUT", qty: -1 });

        // The item comes back: Packing checks it, it goes back on the shelf
        // at the cost it left with, and both the case and the order complete.
        const rc = await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } });
        const { completeConditionCheck } = await import("@/lib/returns/condition-check");
        await completeConditionCheck(tx, { inspectionId: rc.inspectionId!, lines: [{ orderItemId: order.items[0].id, goodQty: 1, damagedQty: 0 }] }, packer.id);
        const back = (await movements(tx, catalog.m.id)).at(-1)!;
        expect(back.type).toBe("EXCHANGE_IN");
        expect(toNumber(back.unitCostSnapshot)).toBe(400);
        expect((await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe("COMPLETED");
        expect((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("COMPLETED");

        await ledgerMatches(tx, [catalog.m.id, catalog.l.id]);
        const audit = await tx.auditLog.findMany({ where: { entityId: order.id, action: { in: ["exchange.request", "exchange.approve", "exchange.complete"] } } });
        expect(audit.map((a) => a.action).sort()).toEqual(["exchange.approve", "exchange.complete", "exchange.request"]);
      });
    },
    TIMEOUT,
  );

  it(
    "a cancelled exchange gives everything back: replacement cancelled, reservation released, credit gone, order back to DELIVERED",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const [se, tl] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.TL)]);
        const { id: caseId } = await requestReturnCase(tx, se, {
          orderId: order.id,
          type: "EXCHANGE",
          reason: "WRONG_COLOR",
          courierChargeBearer: "COMPANY",
          lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.l.id }],
        });
        const decision = await decideReturnCase(tx, tl, caseId, { decision: "APPROVE" });
        // An executive can't cancel what was already approved.
        await expect(cancelReturnCase(tx, se, caseId, { note: "changed mind", canApprove: false })).rejects.toThrow(/Only an approver/);
        await cancelReturnCase(tx, tl, caseId, { note: "Customer kept the original", canApprove: true });

        const replacement = await tx.order.findUniqueOrThrow({ where: { id: decision!.replacementOrderId! } });
        expect(replacement.status).toBe("CANCELLED");
        expect((await tx.productVariant.findUniqueOrThrow({ where: { id: catalog.l.id } })).reservedQty).toBe(0);
        expect(await tx.payment.count({ where: { returnCaseId: caseId } })).toBe(0);
        const original = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
        expect(original.status).toBe("DELIVERED");
        expect(original.items[0].returnedQty).toBe(0);
        expect(toNumber(original.total)).toBe(1430);
        expect(toNumber(original.dueAmount)).toBe(0);
        expect(await tx.returnInspection.count({ where: { orderId: order.id } })).toBe(0);
      });
    },
    TIMEOUT,
  );

  it(
    "refuses what it can't honour: more units than the customer has, a replacement out of stock, a replacement order cancelled by hand",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const se = await userFor(tx, PHONES.SE);
        const base = { orderId: order.id, type: "EXCHANGE" as const, reason: "WRONG_SIZE" as const, courierChargeBearer: "CUSTOMER" as const };
        await expect(requestReturnCase(tx, se, { ...base, lines: [{ orderItemId: order.items[0].id, qty: 2, replacementVariantId: catalog.l.id }] })).rejects.toThrow(/only 1 can come back/);
        await tx.productVariant.update({ where: { id: catalog.l.id }, data: { reservedQty: 10 } });
        await expect(requestReturnCase(tx, se, { ...base, lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.l.id }] })).rejects.toThrow(ReturnCaseError);
        // A second request for the same unit while one waits is refused.
        await requestReturnCase(tx, se, { orderId: order.id, type: "RETURN", reason: "DEFECTIVE", lines: [{ orderItemId: order.items[0].id, qty: 1 }] });
        await expect(requestReturnCase(tx, se, { orderId: order.id, type: "RETURN", reason: "DEFECTIVE", lines: [{ orderItemId: order.items[0].id, qty: 1 }] })).rejects.toThrow(/already returned or in another request/);
      });
    },
    TIMEOUT,
  );

  it(
    "the company-borne courier charge posts once, under Exchange / return cost",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { replacement, caseId } = await runOnlineExchange(tx);
        const courier = await tx.courierCompany.findFirstOrThrow();
        await tx.shipment.create({ data: { orderId: replacement.id, courierId: courier.id, courierCostEstimate: 70, courierCostActual: 65, finalizedAt: new Date() } });
        expect(await postExchangeCourierCost(tx, replacement.id, null)).toBe("65");
        expect(await postExchangeCourierCost(tx, replacement.id, null)).toBeNull();
        const expenses = await tx.expense.findMany({ where: { exchangeCourierCaseId: caseId } });
        expect(expenses).toHaveLength(1);
        expect(expenses[0].categoryId).toBe(EXCHANGE_COURIER_EXPENSE_CATEGORY_ID);
        expect((await tx.expenseCategory.findUniqueOrThrow({ where: { id: EXCHANGE_COURIER_EXPENSE_CATEGORY_ID } })).kind).toBe("EXCHANGE_RETURN");

        // Verify Phase 3: it shows on the expense screen as system-posted, and
        // can't be edited or deleted there (it would drift from the case).
        const admin = await userFor(tx, PHONES.ADMIN);
        await expect(updateExpense(tx, expenses[0].id, { amount: 1 }, admin.id)).rejects.toThrow(/posted by the exchange courier charge/);
        await expect(deleteExpense(tx, expenses[0].id, admin.id)).rejects.toThrow(ExpenseError);
      });
    },
    TIMEOUT,
  );

  it(
    "a company-borne parcel paid out before its final status arrives still posts under Exchange / return cost, once",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { replacement, caseId } = await runOnlineExchange(tx);
        const courier = await tx.courierCompany.findFirstOrThrow();
        // Booked, not yet final — then the payout arrives.
        const shipment = await tx.shipment.create({ data: { orderId: replacement.id, courierId: courier.id, courierCostEstimate: 70 } });
        const statement = await tx.courierStatement.create({
          data: {
            courierId: courier.id,
            source: "MANUAL",
            reference: `VERIFY-P3-${Date.now()}`,
            status: "PAID",
            statementDate: new Date(),
            grossAmount: 0,
            deliveryCharge: 60,
            codCharge: 0,
            netAmount: -60,
            lines: { create: [{ lineNo: 1, codAmount: 0, deliveryCharge: 60, codCharge: 0, shipmentId: shipment.id, orderId: replacement.id, status: "MATCHED" }] },
          },
        });
        expect(await finalizeStatement(tx, statement.id, null)).toBe(true);

        const posted = await tx.expense.findMany({ where: { exchangeCourierCaseId: caseId } });
        expect(posted.map((e) => [e.categoryId, toNumber(e.amount)])).toEqual([[EXCHANGE_COURIER_EXPENSE_CATEGORY_ID, 60]]);
        // …and not a second time under Courier.
        const reconciled = await tx.courierStatement.findUniqueOrThrow({ where: { id: statement.id } });
        expect(reconciled.deliveryChargeExpenseId).toBeNull();
        // The final status arriving later posts nothing more.
        await tx.shipment.update({ where: { id: shipment.id }, data: { finalizedAt: new Date() } });
        expect(await postExchangeCourierCost(tx, replacement.id, null)).toBeNull();
      });
    },
    TIMEOUT,
  );

  it(
    "a replacement order takes no share of the day's ad spend — it isn't a new sale",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { replacement } = await runOnlineExchange(tx);
        const allocation = await getDayAllocation(tx, todayInDhaka());
        expect(allocation.orders.map((o) => o.id)).not.toContain(replacement.id);
      });
    },
    TIMEOUT,
  );
});

describe("counter exchange (PRD §4.11 B)", () => {
  it(
    "both stock movements in one transaction, no courier, the difference paid on the spot, a damaged unit written off",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { catalog, order, result } = await runCounterExchange(tx);
        const replacement = await tx.order.findUniqueOrThrow({ where: { id: result.replacementOrderId }, include: { shipment: true, items: true } });
        expect(replacement).toMatchObject({ channel: "WALK_IN", status: "COMPLETED", exchangedFromOrderId: order.id, shipment: null, courierId: null });
        expect(toNumber(replacement.dueAmount)).toBe(0);
        expect(result).toMatchObject({ paid: "800.00", storeCreditIssued: "0.00", restockedUnits: 0, writtenOffUnits: 1 });
        expect((await movements(tx, catalog.pricier.id)).at(-1)).toMatchObject({ type: "EXCHANGE_OUT", qty: -1 });
        expect((await movements(tx, catalog.m.id)).slice(-2).map((m) => m.type)).toEqual(["EXCHANGE_IN", "DAMAGE_OUT"]);
        expect(toNumber(replacement.items[0].unitCostSnapshot!)).toBe(900);
        const rc = await tx.returnCase.findUniqueOrThrow({ where: { id: result.caseId } });
        expect(rc).toMatchObject({ mode: "COUNTER", status: "COMPLETED", courierChargeBearer: null });
        // The original keeps its status; the customer kept one of two.
        expect((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DELIVERED");
        await ledgerMatches(tx, [catalog.m.id, catalog.pricier.id]);
      });
    },
    TIMEOUT,
  );

  it(
    "a cheaper replacement goes to the customer's store credit at once — no refund, no approval, no cash",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const catalog = await scratchCatalog(tx);
        const order = await deliveredOrder(tx, catalog.m.id);
        const pos = await userFor(tx, PHONES.POS);
        const cash = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
        const result = await createCounterExchange(tx, { user: pos, cashWalletId: cash.id, canCreateCustomer: true }, {
          orderId: order.id,
          reason: "NOT_AS_EXPECTED",
          lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.cheaper.id, goodQty: 1, damagedQty: 0 }],
          tenders: [],
        });
        // Returned 1,350; replacement 900 → 450 to store credit.
        expect(result).toMatchObject({ storeCreditIssued: "450.00", storeCreditBalance: "450.00" });
        expect(await tx.payment.count({ where: { returnCaseId: result.caseId, kind: "REFUND" } })).toBe(0);
        expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount)).toBe(0);
        expect((await tx.returnCase.findUniqueOrThrow({ where: { id: result.caseId } })).settlement).toBe("STORE_CREDIT");
      });
    },
    TIMEOUT,
  );
});

describe("return / refund (PRD §4.11)", () => {
  it(
    "the check puts the Good unit back and writes off the Damaged one at cost; an approved refund makes the order REFUNDED",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { catalog, order, caseId } = await runReturnWithDamage(tx);
        const after = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
        expect(after.status).toBe("RETURNED");
        expect(after.items[0].returnedQty).toBe(2);
        // 2 × 1,450 − 100 came back: the customer is owed it.
        expect(toNumber(after.total)).toBe(80);
        expect(toNumber(after.dueAmount)).toBe(-2800);
        expect((await movements(tx, catalog.m.id)).slice(-3).map((m) => m.type)).toEqual(["RETURN_IN", "RETURN_IN", "DAMAGE_OUT"]);
        const writeOff = await tx.expense.findFirstOrThrow({ where: { stockMovement: { variantId: catalog.m.id, type: "DAMAGE_OUT" } } });
        expect(toNumber(writeOff.amount)).toBe(400);
        expect((await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe("COMPLETED");
        await ledgerMatches(tx, [catalog.m.id]);

        const [accounts, manager] = await Promise.all([userFor(tx, PHONES.ACCOUNTS), userFor(tx, PHONES.MANAGER)]);
        const { requestRefund } = await import("@/lib/payments/refunds");
        const refund = await requestRefund(tx, order.id, { amount: 2800, method: "BKASH", reason: "Returned — not as expected" }, accounts.id);
        await decideRefund(tx, refund.id, { decision: "APPROVE" }, manager.id);
        expect((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
      });
    },
    TIMEOUT,
  );
});

describe("who sees what", () => {
  it(
    "an SE lists only returns on their own orders; the report's courier charge is stripped for them",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { order } = await runOnlineExchange(tx);
        const se = await userFor(tx, PHONES.SE);
        const tl = await userFor(tx, PHONES.TL);
        // A TL's own order, outside the SE's scope.
        const tlOrder = await deliveredOrder(tx, (await scratchCatalog(tx)).m.id);
        await tx.order.update({ where: { id: tlOrder.id }, data: { createdById: tl.id } });
        await requestReturnCase(tx, tl, { orderId: tlOrder.id, type: "RETURN", reason: "DEFECTIVE", lines: [{ orderItemId: tlOrder.items[0].id, qty: 1 }] });

        const seDone = await listReturnCases(tx, se, { tab: "done", page: 1, pageSize: 100 });
        expect(seDone.items.some((c) => c.order.id === order.id)).toBe(true);
        const seOpen = await listReturnCases(tx, se, { tab: "requested", page: 1, pageSize: 100 });
        expect(seOpen.items.some((c) => c.order.id === tlOrder.id)).toBe(false);
        expect(JSON.stringify(seDone)).not.toMatch(/unitCost|weightedAvgCost|companyCourierCost/);

        // The channel filter narrows by the original sale's channel, inside the scope.
        const online = await listReturnCases(tx, se, { tab: "done", channel: "ONLINE", page: 1, pageSize: 100 });
        expect(online.items.some((c) => c.order.id === order.id)).toBe(true);
        const walkIn = await listReturnCases(tx, se, { tab: "done", channel: "WALK_IN", page: 1, pageSize: 100 });
        expect(walkIn.items.some((c) => c.order.id === order.id)).toBe(false);
        expect(walkIn.items.every((c) => c.order.channel === "WALK_IN")).toBe(true);
      });

      // Route level, on the seeded data: no cost key in the SE's report.
      const { prisma } = await import("@/lib/prisma");
      const se = await userFor(prisma as unknown as Prisma.TransactionClient, PHONES.SE);
      session.current = { user: se };
      const report = await (await reportGET(new NextRequest("http://localhost/api/returns/report"))).json();
      expect(report.report.totals).not.toHaveProperty("companyCourierCost");
      const admin = await userFor(prisma as unknown as Prisma.TransactionClient, PHONES.ADMIN);
      session.current = { user: admin };
      const adminReport = await (await reportGET(new NextRequest("http://localhost/api/returns/report"))).json();
      expect(adminReport.report.totals).toHaveProperty("companyCourierCost");

      // Packing has no business with return requests.
      const packing = await userFor(prisma as unknown as Prisma.TransactionClient, PHONES.PACKING);
      session.current = { user: packing };
      expect((await listGET(new NextRequest("http://localhost/api/returns"))).status).toBe(403);
      // And an SE can't ask for a return on an order outside their scope.
      session.current = { user: se };
      const foreign = await prisma.order.findFirst({ where: { createdById: { not: se.id }, status: { in: ["DELIVERED", "COMPLETED"] }, deletedAt: null }, include: { items: true } });
      if (foreign) {
        const res = await requestPOST(
          new NextRequest("http://localhost/api/returns", {
            method: "POST",
            body: JSON.stringify({ orderId: foreign.id, type: "RETURN", reason: "DEFECTIVE", lines: [{ orderItemId: foreign.items[0].id, qty: 1 }] }),
          }),
        );
        expect(res.status).toBe(404);
      }
    },
    TIMEOUT,
  );
});
