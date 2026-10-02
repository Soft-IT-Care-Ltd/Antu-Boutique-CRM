import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers call auth(); next-auth can't load under plain Node, so the
// session is whatever the test says it is.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { GET as expensesGET } from "@/app/api/expenses/route";
import { GET as paymentsGET } from "@/app/api/payments/route";
import { GET as collectionGET } from "@/app/api/reports/collection/route";
import { GET as expenseReportGET } from "@/app/api/reports/expenses/route";
import { GET as walletsGET } from "@/app/api/wallets/route";
import { can } from "@/lib/auth/permissions";
import { sessionUserFor, uniquePhone } from "@/lib/courier/__tests__/helpers";
import { getDayAllocation } from "@/lib/expenses/ad-allocation";
import { AD_COST_CATEGORY_ID } from "@/lib/expenses/constants";
import { createAdSpend, createExpense, deleteAdSpend, ExpenseError, updateAdSpend, updateExpense } from "@/lib/expenses/service";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { toNumber } from "@/lib/money";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { verifyPayments } from "@/lib/payments/queries";
import { decideRefund, RefundError, requestRefund } from "@/lib/payments/refunds";
import { getCollectionReport, getExpenseReport } from "@/lib/reports/finance";
import { inRolledBackTransaction } from "@/lib/test/rollback";
import { getWalletBalances, getWalletStatement } from "@/lib/wallets/ledger";
import { createManualEntry, createTransfer, resolvePaymentWalletId, voidWalletEntry, WalletError } from "@/lib/wallets/service";

// P2.3 — wallets, verification, refunds, expenses, ad spend (PRD §4.10,
// §4.12). Everything runs in a rolled-back transaction on antu_test.

beforeEach(() => {
  session.current = null;
});

const ADMIN = "01711000001";
const MANAGER = "01711000002";
const TL = "01711000003";
const SE = "01711000004";
const PACKING = "01711000005";
const ACCOUNTS = "01711000006";

/** A test-only wallet (so seeded payments don't muddy the numbers), opened 1 Jan 2026 with ৳1,000. */
async function freshWallet(tx: Prisma.TransactionClient, type: "BKASH" | "BANK" | "CASH" = "BKASH", opening = 1000) {
  return tx.wallet.create({ data: { name: `Test ${type} ${uniquePhone()}`, type, openingBalance: opening, openingDate: dhakaDayStartUtc("2026-01-01"), sortOrder: 0 } });
}

/** A CONFIRMED order of `total`, first confirmed at `confirmedAt`. */
async function makeOrder(tx: Prisma.TransactionClient, total: number, confirmedAt = new Date()) {
  const se = await tx.user.findUniqueOrThrow({ where: { phone: SE } });
  const customer = await tx.customer.create({ data: { name: "Finance Test", phone: uniquePhone(), createdById: se.id, teamId: se.teamId } });
  const order = await tx.order.create({
    data: { orderNo: `TEST-FIN-${uniquePhone()}`, status: "CONFIRMED", customerId: customer.id, subtotal: total, total, dueAmount: total, createdById: se.id, teamId: se.teamId },
  });
  await tx.orderStatusHistory.create({ data: { orderId: order.id, toStatus: "CONFIRMED", changedById: se.id, createdAt: confirmedAt } });
  return order;
}

async function pay(tx: Prisma.TransactionClient, orderId: string, amount: number, walletId: string, opts: { verified?: boolean; paidAt?: Date } = {}) {
  const se = await tx.user.findUniqueOrThrow({ where: { phone: SE } });
  const p = await tx.payment.create({
    data: { orderId, amount, method: "BKASH", walletId, receivedById: se.id, verified: opts.verified ?? false, paidAt: opts.paidAt ?? new Date(), transactionId: `TEST-${uniquePhone()}` },
  });
  await recomputeOrderDueAmount(tx, orderId);
  return p;
}

const balanceOf = async (tx: Prisma.TransactionClient, id: string) => (await getWalletBalances(tx, { walletId: id }))[0];

describe("wallet balances are derived from what moved the money", () => {
  it("verified payments count, unverified are only 'pending'; refunds, expenses, entries, transfers and courier payouts all land", async () => {
    await inRolledBackTransaction(async (tx) => {
      const bkash = await freshWallet(tx, "BKASH", 1000);
      const bank = await freshWallet(tx, "BANK", 0);
      const accounts = await sessionUserFor(ACCOUNTS);
      const manager = await sessionUserFor(MANAGER);
      const order = await makeOrder(tx, 5000);

      const unverified = await pay(tx, order.id, 2000, bkash.id);
      let b = await balanceOf(tx, bkash.id);
      expect(toNumber(b.balance)).toBe(1000);
      expect(b).toMatchObject({ pendingVerificationCount: 1, pendingVerification: "2000.00" });

      expect(await verifyPayments(tx, accounts, [unverified.id])).toBe(1);
      b = await balanceOf(tx, bkash.id);
      expect(toNumber(b.balance)).toBe(3000);
      expect(b.pendingVerificationCount).toBe(0);
      const verified = await tx.payment.findUniqueOrThrow({ where: { id: unverified.id } });
      expect(verified).toMatchObject({ verified: true, verifiedById: accounts.id });
      expect(await tx.auditLog.count({ where: { action: "payment.verify", entityId: order.id } })).toBe(1);

      // A pending refund moves nothing; once approved it leaves the wallet.
      const refund = await requestRefund(tx, order.id, { amount: 500, method: "BKASH", walletId: bkash.id, reason: "Paid twice" }, accounts.id);
      expect(toNumber((await balanceOf(tx, bkash.id)).balance)).toBe(3000);
      await decideRefund(tx, refund.id, { decision: "APPROVE" }, manager.id);
      expect(toNumber((await balanceOf(tx, bkash.id)).balance)).toBe(2500);

      await createExpense(tx, { expenseDate: new Date(), categoryId: "expcat_packaging", nature: "VARIABLE", amount: 300, walletId: bkash.id }, accounts.id);
      await createManualEntry(tx, { walletId: bkash.id, direction: "IN", amount: 100, entryDate: new Date(), note: "Owner top-up" }, accounts.id);
      const { transferId } = await createTransfer(tx, { fromWalletId: bkash.id, toWalletId: bank.id, amount: 1000, entryDate: new Date(), note: "Cash-out" }, accounts.id);
      expect(toNumber((await balanceOf(tx, bkash.id)).balance)).toBe(2500 - 300 + 100 - 1000);
      expect(toNumber((await balanceOf(tx, bank.id)).balance)).toBe(1000);

      // Voiding one half of a transfer voids both.
      const half = await tx.walletEntry.findFirstOrThrow({ where: { transferId, type: "TRANSFER_IN" } });
      expect(await voidWalletEntry(tx, half.id, "Entered twice", accounts.id)).toBe(2);
      expect(toNumber((await balanceOf(tx, bkash.id)).balance)).toBe(2300);
      expect(toNumber((await balanceOf(tx, bank.id)).balance)).toBe(0);

      // A courier payout lands its NET once the courier has paid.
      const steadfast = await tx.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } });
      await tx.courierStatement.create({
        data: { courierId: steadfast.id, source: "MANUAL", reference: `TEST-${uniquePhone()}`, status: "PAID", statementDate: new Date(), grossAmount: 1000, deliveryCharge: 60, codCharge: 9, netAmount: 931, walletId: bank.id },
      });
      expect(toNumber((await balanceOf(tx, bank.id)).balance)).toBe(931);
    });
  }, 120_000);

  it("money dated before the opening date is already inside the opening balance; the statement runs the balance line by line", async () => {
    await inRolledBackTransaction(async (tx) => {
      const wallet = await freshWallet(tx, "CASH", 5000);
      const accounts = await sessionUserFor(ACCOUNTS);
      await tx.wallet.update({ where: { id: wallet.id }, data: { openingDate: dhakaDayStartUtc("2026-03-01") } });
      await createManualEntry(tx, { walletId: wallet.id, direction: "IN", amount: 999, entryDate: dhakaDayStartUtc("2026-02-15"), note: "Before opening" }, accounts.id);
      await createManualEntry(tx, { walletId: wallet.id, direction: "IN", amount: 200, entryDate: dhakaDayStartUtc("2026-03-05"), note: "In March" }, accounts.id);
      await createExpense(tx, { expenseDate: dhakaDayStartUtc("2026-04-02"), categoryId: "expcat_transport", nature: "VARIABLE", amount: 150, walletId: wallet.id }, accounts.id);
      await createManualEntry(tx, { walletId: wallet.id, direction: "OUT", amount: 50, entryDate: dhakaDayStartUtc("2026-04-10"), note: "Tea" }, accounts.id);

      expect(toNumber((await balanceOf(tx, wallet.id)).balance)).toBe(5000 + 200 - 150 - 50);

      const april = (await getWalletStatement(tx, wallet.id, dhakaDayStartUtc("2026-04-01"), dhakaDayStartUtc("2026-04-30", 1)))!;
      expect(april).toMatchObject({ openingBalance: "5200.00", moneyIn: "0.00", moneyOut: "200.00", closingBalance: "5000.00" });
      expect(april.rows.map((r) => [r.source, r.amount, r.balance])).toEqual([
        ["EXPENSE", "-150.00", "5050.00"],
        ["ENTRY", "-50.00", "5000.00"],
      ]);
    });
  }, 60_000);
});

describe("which wallet a payment lands in", () => {
  it("defaults by method, refuses a wallet of the wrong type, and never gives courier COD a wallet", async () => {
    await inRolledBackTransaction(async (tx) => {
      const nagad = await tx.wallet.findFirstOrThrow({ where: { type: "NAGAD", isActive: true }, orderBy: { sortOrder: "asc" } });
      const cash = await tx.wallet.findFirstOrThrow({ where: { type: "CASH", isActive: true } });
      expect(await resolvePaymentWalletId(tx, "NAGAD", undefined)).toBe(nagad.id);
      await expect(resolvePaymentWalletId(tx, "BKASH", cash.id)).rejects.toThrow(WalletError);
      await expect(resolvePaymentWalletId(tx, "COURIER_COD", cash.id)).rejects.toThrow(WalletError);
      expect(await resolvePaymentWalletId(tx, "COURIER_COD", undefined)).toBeNull();
      await tx.wallet.update({ where: { id: cash.id }, data: { isActive: false } });
      await expect(resolvePaymentWalletId(tx, "CASH", cash.id)).rejects.toThrow(/active wallet/);
    });
  }, 60_000);

  it("the database itself refuses a courier-COD payment with a wallet, and a refund that isn't negative or has no reason", async () => {
    // Each attempt in its own rolled-back transaction: a CHECK failure aborts it.
    for (const data of [
      { method: "COURIER_COD" as const, amount: 100, walletId: "wallet_bank" },
      { method: "BKASH" as const, amount: 100, kind: "REFUND" as const, refundStatus: "PENDING" as const, refundReason: "x" },
      { method: "BKASH" as const, amount: -100, kind: "REFUND" as const, refundStatus: "PENDING" as const },
      { method: "BKASH" as const, amount: -100 },
    ]) {
      await expect(
        inRolledBackTransaction(async (tx) => {
          const o = await makeOrder(tx, 1000);
          await tx.payment.create({ data: { orderId: o.id, ...data } });
        }),
      ).rejects.toThrow(/check constraint|violates/i);
    }
  }, 90_000);
});

describe("refunds: negative payments with a reason and a second person's approval", () => {
  it("pending doesn't touch due_amount; self-approval is refused; approval does; rejecting needs a reason; nobody decides twice", async () => {
    await inRolledBackTransaction(async (tx) => {
      const accounts = await sessionUserFor(ACCOUNTS);
      const manager = await sessionUserFor(MANAGER);
      const wallet = await freshWallet(tx);
      const order = await makeOrder(tx, 3000);
      await pay(tx, order.id, 3000, wallet.id, { verified: true });
      expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount)).toBe(0);

      await expect(requestRefund(tx, order.id, { amount: 3500, method: "BKASH", walletId: wallet.id, reason: "Too much" }, accounts.id)).rejects.toThrow(RefundError);

      const refund = await requestRefund(tx, order.id, { amount: 1000, method: "BKASH", walletId: wallet.id, reason: "Returned one kurti" }, accounts.id);
      expect(toNumber(refund.amount)).toBe(-1000);
      expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount)).toBe(0);

      await expect(decideRefund(tx, refund.id, { decision: "APPROVE" }, accounts.id)).rejects.toThrow(/someone other than/);
      await expect(decideRefund(tx, refund.id, { decision: "REJECT" }, manager.id)).rejects.toThrow(/reason/);

      await decideRefund(tx, refund.id, { decision: "APPROVE", note: "OK" }, manager.id);
      expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount)).toBe(1000);
      await expect(decideRefund(tx, refund.id, { decision: "REJECT", note: "late" }, manager.id)).rejects.toThrow(/already been decided/);

      // A second refund can't take more than what's left.
      await expect(requestRefund(tx, order.id, { amount: 2500, method: "BKASH", walletId: wallet.id, reason: "Again" }, accounts.id)).rejects.toThrow(/Only ৳2000/);

      const rejected = await requestRefund(tx, order.id, { amount: 200, method: "BKASH", walletId: wallet.id, reason: "Maybe" }, accounts.id);
      await decideRefund(tx, rejected.id, { decision: "REJECT", note: "Not agreed with customer" }, manager.id);
      expect(toNumber((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).dueAmount)).toBe(1000);
      expect(await tx.auditLog.count({ where: { entityId: order.id, action: { startsWith: "payment.refund." } } })).toBe(4);
    });
  }, 90_000);
});

describe("expenses and ad spend", () => {
  it("system categories can't be picked; system-posted expenses can't be edited by hand; every change is audited", async () => {
    await inRolledBackTransaction(async (tx) => {
      const accounts = await sessionUserFor(ACCOUNTS);
      const wallet = await freshWallet(tx, "CASH");
      await expect(createExpense(tx, { expenseDate: new Date(), categoryId: AD_COST_CATEGORY_ID, nature: "VARIABLE", amount: 100, walletId: wallet.id }, accounts.id)).rejects.toThrow(
        /Ad spend screen/,
      );
      const rent = await createExpense(tx, { expenseDate: new Date(), categoryId: "expcat_rent", nature: "FIXED", amount: 20000, walletId: wallet.id, note: "Rent" }, accounts.id);
      await updateExpense(tx, rent.id, { amount: 21000 }, accounts.id);
      expect(await tx.auditLog.count({ where: { entityType: "expense", entityId: rent.id } })).toBe(2);

      const spend = await createAdSpend(tx, { spendDate: dhakaDayStartUtc("2026-05-10"), platform: "FACEBOOK", amount: 800, walletId: wallet.id }, accounts.id);
      const posted = await tx.expense.findUniqueOrThrow({ where: { adSpendId: spend.id } });
      expect(posted).toMatchObject({ categoryId: AD_COST_CATEGORY_ID, walletId: wallet.id });
      await expect(updateExpense(tx, posted.id, { amount: 1 }, accounts.id)).rejects.toThrow(ExpenseError);

      await updateAdSpend(tx, spend.id, { amount: 950 }, accounts.id);
      expect(toNumber((await tx.expense.findUniqueOrThrow({ where: { adSpendId: spend.id } })).amount)).toBe(950);
      await deleteAdSpend(tx, spend.id, accounts.id);
      expect((await tx.expense.findUniqueOrThrow({ where: { adSpendId: spend.id } })).deletedAt).not.toBeNull();
    });
  }, 60_000);

  it("a day's ad spend spreads over that day's confirmed orders — equally or by value — and cancelled orders get none", async () => {
    await inRolledBackTransaction(async (tx) => {
      const admin = await sessionUserFor(ADMIN);
      const wallet = await freshWallet(tx);
      // A Dhaka day a year ahead: the seed only ever dates its orders in the
      // past, so no seeded order can be confirmed on it whenever the seed ran.
      const dhakaDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
      const day = dhakaDay(400);
      const noon = new Date(`${day}T12:00:00+06:00`);
      const a = await makeOrder(tx, 1000, noon);
      const b = await makeOrder(tx, 3000, noon);
      const cancelled = await makeOrder(tx, 5000, noon);
      await tx.order.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
      await makeOrder(tx, 9000, new Date(`${dhakaDay(401)}T00:30:00+06:00`)); // just past midnight: the next Dhaka day
      await createAdSpend(tx, { spendDate: dhakaDayStartUtc(day), platform: "FACEBOOK", amount: 1000, walletId: wallet.id }, admin.id);

      // No other order is confirmed on this day, so only ours count.
      const equal = await getDayAllocation(tx, day, "EQUAL");
      expect(equal.orders.map((o) => [o.id, o.allocated])).toEqual([
        [a.id, "500.00"],
        [b.id, "500.00"],
      ]);
      const byValue = await getDayAllocation(tx, day, "BY_VALUE");
      expect(Object.fromEntries(byValue.orders.map((o) => [o.id, o.allocated]))).toEqual({ [a.id]: "250.00", [b.id]: "750.00" });

      const empty = await getDayAllocation(tx, dhakaDay(399), "EQUAL");
      expect(empty.orders).toHaveLength(0);
    });
  }, 60_000);

  it("the collection and expense reports add up", async () => {
    await inRolledBackTransaction(async (tx) => {
      const admin = await sessionUserFor(ADMIN);
      const manager = await sessionUserFor(MANAGER);
      const accounts = await sessionUserFor(ACCOUNTS);
      const wallet = await freshWallet(tx);
      const day = "2026-07-20";
      const at = new Date(`${day}T11:00:00+06:00`);
      const order = await makeOrder(tx, 4000, at);
      await pay(tx, order.id, 1500, wallet.id, { verified: true, paidAt: at });
      await pay(tx, order.id, 500, wallet.id, { verified: false, paidAt: at });
      const refund = await requestRefund(tx, order.id, { amount: 200, method: "BKASH", walletId: wallet.id, reason: "Discount after the fact", paidAt: at }, accounts.id);
      await decideRefund(tx, refund.id, { decision: "APPROVE" }, manager.id);
      await createExpense(tx, { expenseDate: dhakaDayStartUtc(day), categoryId: "expcat_salary", nature: "FIXED", amount: 10000, walletId: wallet.id }, accounts.id);
      await createAdSpend(tx, { spendDate: dhakaDayStartUtc(day), platform: "INSTAGRAM", amount: 700, walletId: wallet.id }, admin.id);

      const from = dhakaDayStartUtc(day);
      const to = dhakaDayStartUtc(day, 1);
      const collection = await getCollectionReport(tx, admin, from, to);
      expect(collection.totals).toMatchObject({ collected: "2000.00", verified: "1500.00", unverified: "500.00", refunds: "200.00", net: "1800.00" });
      expect(collection.byDay).toEqual([{ day, collected: "2000.00", refunds: "200.00", net: "1800.00" }]);

      const expenses = await getExpenseReport(tx, from, to);
      expect(expenses.total).toBe("10700.00");
      expect(Object.fromEntries(expenses.byKind.map((k) => [k.kind, k.amount]))).toEqual({ SALARY: "10000.00", AD_COST: "700.00" });
      expect(Object.fromEntries(expenses.byNature.map((n) => [n.nature, n.amount]))).toEqual({ FIXED: "10000.00", VARIABLE: "700.00" });
    });
  }, 90_000);
});

describe("roles: money screens are Admin / Manager / Accounts only", () => {
  it("permission templates", async () => {
    const roles = { admin: ADMIN, manager: MANAGER, teamLeader: TL, se: SE, packing: PACKING, accounts: ACCOUNTS };
    for (const [role, phone] of Object.entries(roles)) {
      const user = await sessionUserFor(phone);
      const money = role === "admin" || role === "manager" || role === "accounts";
      for (const key of ["wallet.view", "wallet.entry", "expense.view", "payment.view", "payment.refund"] as const) {
        expect(await can(user, key), `${role} ${key}`).toBe(money);
      }
      expect(await can(user, "payment.refund_approve"), `${role} refund_approve`).toBe(role === "admin" || role === "manager");
      expect(await can(user, "wallet.manage"), `${role} wallet.manage`).toBe(role === "admin" || role === "manager");
    }
  }, 90_000);

  it("a Sales Executive and a Team Leader get 403 from every wallet, payment, expense and report route", async () => {
    const req = (url: string) => new NextRequest(`http://localhost${url}`);
    for (const phone of [SE, TL, PACKING]) {
      const u = await sessionUserFor(phone);
      session.current = { user: { id: u.id, role: u.role, teamId: u.teamId } };
      expect((await walletsGET()).status, `${u.role} wallets`).toBe(403);
      expect((await paymentsGET(req("/api/payments"))).status, `${u.role} payments`).toBe(403);
      expect((await expensesGET(req("/api/expenses"))).status, `${u.role} expenses`).toBe(403);
      expect((await collectionGET(req("/api/reports/collection"))).status, `${u.role} collection`).toBe(403);
      expect((await expenseReportGET(req("/api/reports/expenses"))).status, `${u.role} expense report`).toBe(403);
    }
    const accounts = await sessionUserFor(ACCOUNTS);
    session.current = { user: { id: accounts.id, role: accounts.role, teamId: accounts.teamId } };
    const res = await walletsGET();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { wallets: unknown[] }).wallets.length).toBeGreaterThan(0);
  }, 120_000);
});
