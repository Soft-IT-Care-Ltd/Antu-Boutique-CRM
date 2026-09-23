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

import { makePackedOrder, orderStatus, sendOne, sessionUserFor, setupIntegration, webhook } from "@/lib/courier/__tests__/helpers";
import { CourierConfigError } from "@/lib/courier/integration";
import { runSteadfastPayoutsSync } from "@/lib/courier/payouts/sync";
import { ingestCourierStatement, resolveStatementLine } from "@/lib/courier/reconcile";
import * as steadfast from "@/lib/courier/steadfast/client";
import { toNumber } from "@/lib/money";
import { completeConditionCheck } from "@/lib/returns/condition-check";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// P2.2b — COD reconciliation and Steadfast payouts, against the mocked client,
// inside rolled-back transactions. Requires `npm run db:seed`.

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

/** "YYYY-MM-DD HH:MM:SS" in Asia/Dhaka — the zone-less shape Steadfast sends. */
const dhakaStamp = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);

/** A real order taken all the way to DELIVERED through Steadfast (mocked), with the courier's charge reported. */
async function deliveredOrder(tx: Prisma.TransactionClient, cid: number, charge = 60) {
  const { order } = await makePackedOrder(tx);
  await sendOne(tx, order.id, cid, `T${cid}`);
  await webhook(tx, { notification_type: "delivery_status", consignment_id: cid, status: "pending" });
  sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: {} });
  await webhook(tx, { notification_type: "delivery_status", consignment_id: cid, status: "delivered", delivery_charge: charge });
  expect(await orderStatus(tx, order.id)).toBe("DELIVERED");
  const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
  return { order, shipment, cod: toNumber(shipment.codAmount) };
}

function mockPayouts(payouts: Record<string, unknown>[], consignmentsByRef: Record<string, Record<string, unknown>[]>) {
  sf.getPayments.mockImplementation(async (_creds, page = 1) => ({ status: 1, payments: page === 1 ? payouts : [] }));
  sf.getPaymentDetail.mockImplementation(async (_creds, id) => {
    const payout = payouts.find((p) => String(p.payment_id).endsWith(id))!;
    return { payment: payout, consignments: consignmentsByRef[String(payout.payment_id)] ?? [] };
  });
}

const steadfastCourierId = async (tx: Prisma.TransactionClient) => (await tx.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } })).id;

describe("Steadfast payouts → COD settled, order completed, charges expensed once", () => {
  it("a matching paid payout settles the order's COD, completes it, posts both charges, and a re-sync changes nothing", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor("01711000001");
      const { order, shipment, cod } = await deliveredOrder(tx, 8_100_001, 60);
      const fee = Math.round((cod - 60) * 0.01); // their invoice rounds to whole taka
      mockPayouts(
        [{ payment_id: "SFC-81000001", amount: cod, due_bills: 60, charges: fee, total: cod - 60 - fee, status_label: "paid", paid_at: dhakaStamp() }],
        { "SFC-81000001": [{ consignment_id: 8_100_001, invoice: order.orderNo, cod_amount: cod, status: "delivered" }] },
      );

      const summary = await runSteadfastPayoutsSync(tx, { actorId: admin.id, delayMs: 0 });
      expect(summary).toMatchObject({ payouts: 1, created: 1, settled: 1, discrepancies: 0, unmatched: 0, completed: 1, errors: [] });

      const payments = await tx.payment.findMany({ where: { orderId: order.id, method: "COURIER_COD" } });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ verified: true, transactionId: `COD-SFC-81000001-8100001` });
      expect(toNumber(payments[0].amount)).toBe(cod);
      const after = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(toNumber(after.dueAmount)).toBe(0);
      expect(after.status).toBe("COMPLETED");
      expect((await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).codReceivedAt).not.toBeNull();

      const statement = await tx.courierStatement.findFirstOrThrow({ where: { reference: "SFC-81000001" }, include: { lines: true, deliveryChargeExpense: true, codChargeExpense: true } });
      expect(statement.lines[0]).toMatchObject({ status: "MATCHED", orderId: order.id });
      expect(toNumber(statement.lines[0].expectedNet!)).toBeCloseTo(cod - 60 - (cod - 60) * 0.01, 2);
      expect(statement.reconciledAt).not.toBeNull();
      expect(toNumber(statement.deliveryChargeExpense!.amount)).toBe(60);
      expect(toNumber(statement.codChargeExpense!.amount)).toBe(fee);

      // Replay: same payout again → no new payment, no new expense, no second detail fetch.
      const expensesBefore = await tx.expense.count();
      const again = await runSteadfastPayoutsSync(tx, { actorId: admin.id, delayMs: 0 });
      expect(again).toMatchObject({ created: 0, settled: 0 });
      expect(await tx.payment.count({ where: { orderId: order.id, method: "COURIER_COD" } })).toBe(1);
      expect(await tx.expense.count()).toBe(expensesBefore);
      expect(sf.getPaymentDetail).toHaveBeenCalledTimes(1);
      await checkDeferredConstraintsNow(tx);
    });
  }, 120_000);

  it("a processing payout records nothing until it is paid — then settles exactly once", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order, cod } = await deliveredOrder(tx, 8_100_002);
      const payout = { payment_id: "SFC-81000002", amount: cod, due_bills: 60, charges: 10, total: cod - 70, status_label: "processing", created_at: dhakaStamp() };
      const consignments = { "SFC-81000002": [{ consignment_id: 8_100_002, invoice: order.orderNo, cod_amount: cod }] };
      mockPayouts([payout], consignments);
      expect(await runSteadfastPayoutsSync(tx, { delayMs: 0 })).toMatchObject({ created: 1, settled: 0 });
      expect(await tx.payment.count({ where: { orderId: order.id, method: "COURIER_COD" } })).toBe(0);
      expect((await tx.courierStatement.findFirstOrThrow({ where: { reference: "SFC-81000002" }, include: { lines: true } })).lines[0].status).toBe("PENDING");

      mockPayouts([{ ...payout, status_label: "paid", paid_at: dhakaStamp() }], consignments);
      expect(await runSteadfastPayoutsSync(tx, { delayMs: 0 })).toMatchObject({ paidTransitions: 1, settled: 1 });
      expect(await tx.payment.count({ where: { orderId: order.id, method: "COURIER_COD" } })).toBe(1);
    });
  }, 120_000);

  it("won't run with the integration switched off", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx, { enabled: false });
      await expect(runSteadfastPayoutsSync(tx, { delayMs: 0 })).rejects.toBeInstanceOf(CourierConfigError);
    });
  }, 60_000);
});

describe("discrepancies — no money moves until Accounts decides", () => {
  it("a short payout is a MISMATCH; accepting it settles their figure (reason recorded), leaving the rest due", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const accounts = await sessionUserFor("01711000006");
      const { order, shipment, cod } = await deliveredOrder(tx, 8_200_001);
      const courierId = await steadfastCourierId(tx);
      const short = cod - 100;
      const outcome = await ingestCourierStatement(
        tx,
        { courierId, source: "STEADFAST_API", reference: "SFC-82000001", status: "PAID", statementDate: new Date(), grossAmount: short, deliveryCharge: 60, codCharge: 10, lines: [{ consignmentId: "8200001", codAmount: short }] },
        null,
      );
      expect(outcome).toMatchObject({ settled: 0, discrepancies: 1, reconciledNow: false });
      const line = await tx.courierStatementLine.findFirstOrThrow({ where: { statement: { reference: "SFC-82000001" } } });
      expect(line.status).toBe("MISMATCH");
      expect(line.mismatchReason).toMatch(/Courier says COD/);
      expect(await tx.payment.count({ where: { orderId: order.id, method: "COURIER_COD" } })).toBe(0);
      expect(await orderStatus(tx, order.id)).toBe("DELIVERED");
      expect((await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).needsAttention).toBe(true);
      expect(await tx.expense.count({ where: { note: { contains: "SFC-82000001" } } })).toBe(0);

      await expect(resolveStatementLine(tx, { lineId: line.id, action: "ACCEPT", note: "ok" }, accounts.id)).rejects.toThrow(/reason/);
      const res = await resolveStatementLine(tx, { lineId: line.id, action: "ACCEPT", note: "Customer paid 100 less at the door — confirmed by phone" }, accounts.id);
      expect(res).toMatchObject({ status: "ACCEPTED", completed: false, reconciledNow: true });
      const refreshed = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(toNumber(refreshed.dueAmount)).toBe(100); // still owed — follow up with the customer
      expect(refreshed.status).toBe("DELIVERED");
      expect(await tx.expense.count({ where: { note: { contains: "SFC-82000001" } } })).toBe(2);
      expect(await tx.auditLog.count({ where: { action: "courier.statement_line.accept" } })).toBeGreaterThan(0);
      await expect(resolveStatementLine(tx, { lineId: line.id, action: "ACCEPT", note: "again please" }, accounts.id)).rejects.toThrow(/Only a mismatched or disputed/);
    });
  }, 120_000);

  it("a parcel that isn't ours stays UNMATCHED: it can be disputed but never accepted, and the statement never reconciles around it", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const accounts = await sessionUserFor("01711000006");
      const { order, cod } = await deliveredOrder(tx, 8_300_001);
      const courierId = await steadfastCourierId(tx);
      const outcome = await ingestCourierStatement(
        tx,
        {
          courierId,
          source: "STEADFAST_API",
          reference: "SFC-83000001",
          status: "PAID",
          statementDate: new Date(),
          lines: [
            { consignmentId: "8300001", invoice: order.orderNo, codAmount: cod },
            { consignmentId: "99999999", invoice: "SOMEONE-ELSE-1", codAmount: 500 },
          ],
        },
        null,
      );
      expect(outcome).toMatchObject({ settled: 1, unmatched: 1, reconciledNow: false });
      const foreign = await tx.courierStatementLine.findFirstOrThrow({ where: { consignmentId: "99999999" } });
      await expect(resolveStatementLine(tx, { lineId: foreign.id, action: "ACCEPT", note: "take it" }, accounts.id)).rejects.toThrow(/Only a mismatched/);
      await resolveStatementLine(tx, { lineId: foreign.id, action: "DISPUTE", note: "Sent from the Steadfast panel, not through the CRM" }, accounts.id);
      const statement = await tx.courierStatement.findFirstOrThrow({ where: { reference: "SFC-83000001" } });
      expect(statement.reconciledAt).toBeNull();
      expect(statement.deliveryChargeExpenseId).toBeNull();
    });
  }, 120_000);

  it("the same parcel on a second statement is flagged, never paid twice", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order, cod } = await deliveredOrder(tx, 8_400_001);
      const courierId = await steadfastCourierId(tx);
      const base = { courierId, source: "STEADFAST_API" as const, status: "PAID" as const, statementDate: new Date(), lines: [{ consignmentId: "8400001", codAmount: cod }] };
      expect(await ingestCourierStatement(tx, { ...base, reference: "SFC-84000001" }, null)).toMatchObject({ settled: 1 });
      expect(await ingestCourierStatement(tx, { ...base, reference: "SFC-84000002" }, null)).toMatchObject({ settled: 0, discrepancies: 1 });
      const second = await tx.courierStatementLine.findFirstOrThrow({ where: { statement: { reference: "SFC-84000002" } } });
      expect(second.mismatchReason).toMatch(/Already settled by statement SFC-84000001/);
      expect(await tx.payment.count({ where: { orderId: order.id, method: "COURIER_COD" } })).toBe(1);
    });
  }, 120_000);
});

describe("CSV / manual statements and returned parcels", () => {
  it("matches by order no., expects zero COD for a returned parcel, and never books its return charge twice", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const accounts = await sessionUserFor("01711000006");
      const packer = await sessionUserFor("01711000005");
      const delivered = await deliveredOrder(tx, 8_500_001, 60);

      // A second parcel comes back: cancelled (API confirms), courier charged 75, Packing checks it in.
      const { order: returned } = await makePackedOrder(tx);
      await sendOne(tx, returned.id, 8_500_002, "T8500002");
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "cancelled", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 8_500_002, status: "cancelled", delivery_charge: 75 });
      const inspection = await tx.returnInspection.findFirstOrThrow({ where: { orderId: returned.id } });
      const [item] = await tx.orderItem.findMany({ where: { orderId: returned.id } });
      await completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: item.id, goodQty: item.qty, damagedQty: 0 }] }, packer.id);
      expect(toNumber((await tx.expense.findFirstOrThrow({ where: { returnChargeInspectionId: inspection.id } })).amount)).toBe(75);

      // Accounts types in the courier's statement by order number — both bills on it.
      const courierId = await steadfastCourierId(tx);
      const outcome = await ingestCourierStatement(
        tx,
        {
          courierId,
          source: "MANUAL",
          reference: "PATH-STMT-0923",
          status: "PAID",
          statementDate: new Date(),
          lines: [
            { invoice: delivered.order.orderNo, codAmount: delivered.cod, deliveryCharge: 60 },
            { invoice: returned.orderNo, codAmount: 0, deliveryCharge: 75 },
          ],
        },
        accounts.id,
      );
      expect(outcome).toMatchObject({ settled: 2, discrepancies: 0, reconciledNow: true });
      const statement = await tx.courierStatement.findFirstOrThrow({ where: { reference: "PATH-STMT-0923" }, include: { deliveryChargeExpense: true } });
      expect(toNumber(statement.deliveryCharge)).toBe(135);
      // 135 on the statement − 75 already expensed at the condition check = 60.
      expect(toNumber(statement.deliveryChargeExpense!.amount)).toBe(60);
      // The returned parcel settled with no payment at all.
      expect(await tx.payment.count({ where: { orderId: returned.id, method: "COURIER_COD" } })).toBe(0);
      expect(await orderStatus(tx, delivered.order.id)).toBe("COMPLETED");
      await checkDeferredConstraintsNow(tx);
    });
  }, 120_000);
});
