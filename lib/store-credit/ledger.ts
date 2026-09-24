import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { deriveStoreCredit, type DerivedCredit } from "@/lib/store-credit/balance";
import { MAX_STORE_CREDIT_EXPIRY_DAYS, STORE_CREDIT_EXPIRY_SETTING_KEY } from "@/lib/store-credit/constants";

// ============ Store credit (PRD §4.11, §4.12 — P3.2) ============
//
// What the shop owes a customer, to spend on a later order. One ledger per
// customer (`store_credit_entries`); the balance is derived from it
// (lib/store-credit/balance.ts), never stored.
//
// Every movement but an Admin adjustment goes through an order as ONE
// STORE_CREDIT payment row (no wallet — no money moves) plus its ledger row,
// in the same transaction, so the order's due_amount (rule 1) and the
// customer's balance always agree:
//   ISSUED    −payment on the order the customer overpaid → +credit
//   USED      +payment on the order it pays for          → −credit
//   RESTORED  −payment on that order (cancelled / undone) → +credit
//   ADJUSTED  no payment, reason required, Admin only    → ±credit
//
// Accounting: credit is a liability. Issuing it is neither income nor
// expense — the order it came from already lost the returned items' value
// from its total. It becomes revenue only when spent, as part of the total
// of the order it pays for. Wallets never see it.
//
// Concurrency: every write locks the customer row first (FOR UPDATE), so two
// tills spending the same credit can't both pass the balance check.

export class StoreCreditError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

async function lockCustomer(tx: Prisma.TransactionClient, customerId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "customers" WHERE "id" = ${customerId} FOR UPDATE`;
  if (rows.length === 0) throw new StoreCreditError("Customer not found", 404);
}

async function ledgerRows(db: Db, where: Prisma.StoreCreditEntryWhereInput) {
  const rows = await db.storeCreditEntry.findMany({ where, select: { id: true, customerId: true, amount: true, createdAt: true, expiresAt: true } });
  return rows.map((r) => ({ id: r.id, customerId: r.customerId, amountPaisa: toPaisa(r.amount), createdAt: r.createdAt, expiresAt: r.expiresAt }));
}

/** The customer's credit as of `asOf` (default now). */
export async function getStoreCredit(db: Db, customerId: string, asOf: Date = new Date()): Promise<DerivedCredit> {
  return deriveStoreCredit(await ledgerRows(db, { customerId }), asOf);
}

export async function getStoreCreditBalance(db: Db, customerId: string): Promise<string> {
  return fromPaisa((await getStoreCredit(db, customerId)).balancePaisa);
}

/** Days until newly added credit lapses, or null (never — the default). */
export async function getStoreCreditExpiryDays(db: Db): Promise<number | null> {
  const row = await db.setting.findUnique({ where: { key: STORE_CREDIT_EXPIRY_SETTING_KEY } });
  const days = row?.value?.trim() ? Number(row.value) : NaN;
  return Number.isInteger(days) && days > 0 && days <= MAX_STORE_CREDIT_EXPIRY_DAYS ? days : null;
}

async function expiryForNewCredit(tx: Prisma.TransactionClient, now: Date): Promise<Date | null> {
  const days = await getStoreCreditExpiryDays(tx);
  return days ? new Date(now.getTime() + days * 86_400_000) : null;
}

const CREDIT_PAYMENT = { kind: "STORE_CREDIT", method: "STORE_CREDIT", walletId: null, transactionId: null, verified: true } as const;

/**
 * Credits the customer with part of what they overpaid on `orderId`: a
 * −payment there (so its due goes back up to 0) and a +ISSUED ledger row.
 * No approval and no cash — the money is already in the shop.
 */
export async function issueStoreCredit(
  tx: Prisma.TransactionClient,
  input: { customerId: string; orderId: string; amountPaisa: number; returnCaseId?: string | null; reason: string; actorId: string | null },
): Promise<{ paymentId: string; entryId: string; expiresAt: Date | null }> {
  if (input.amountPaisa <= 0) throw new StoreCreditError("Nothing to credit.");
  await lockCustomer(tx, input.customerId);
  const now = new Date();
  const expiresAt = await expiryForNewCredit(tx, now);
  const payment = await tx.payment.create({
    data: {
      ...CREDIT_PAYMENT,
      orderId: input.orderId,
      amount: fromPaisa(-input.amountPaisa),
      paidAt: now,
      receivedById: input.actorId,
      verifiedById: input.actorId,
      verifiedAt: now,
      returnCaseId: input.returnCaseId ?? null,
      note: input.reason,
    },
    select: { id: true },
  });
  const entry = await tx.storeCreditEntry.create({
    data: {
      customerId: input.customerId,
      type: "ISSUED",
      amount: fromPaisa(input.amountPaisa),
      expiresAt,
      orderId: input.orderId,
      paymentId: payment.id,
      returnCaseId: input.returnCaseId ?? null,
      reason: input.reason,
      createdById: input.actorId,
      createdAt: now,
    },
    select: { id: true },
  });
  await recomputeOrderDueAmount(tx, input.orderId);
  await writeAuditLogWith(tx, {
    actorId: input.actorId,
    action: "store_credit.issue",
    entityType: "customer",
    entityId: input.customerId,
    after: { entryId: entry.id, orderId: input.orderId, paymentId: payment.id, amount: fromPaisa(input.amountPaisa), expiresAt: expiresAt?.toISOString() ?? null, returnCaseId: input.returnCaseId ?? null, reason: input.reason },
  });
  return { paymentId: payment.id, entryId: entry.id, expiresAt };
}

/**
 * Pays `amountPaisa` of `orderId` from the customer's credit: a +payment on
 * the order (verified — nothing to check, no money moved) and a −USED
 * ledger row. Refused beyond what the customer has.
 */
export async function spendStoreCredit(
  tx: Prisma.TransactionClient,
  input: { customerId: string; orderId: string; amountPaisa: number; actorId: string; note?: string | null },
): Promise<{ paymentId: string; entryId: string }> {
  if (input.amountPaisa <= 0) throw new StoreCreditError("Enter how much store credit to use.");
  await lockCustomer(tx, input.customerId);
  const now = new Date();
  const { balancePaisa } = deriveStoreCredit(await ledgerRows(tx, { customerId: input.customerId }), now);
  if (input.amountPaisa > balancePaisa) {
    throw new StoreCreditError(
      balancePaisa > 0 ? `The customer has only ${formatBDT(fromPaisa(balancePaisa))} of store credit.` : "The customer has no store credit.",
      409,
    );
  }
  const payment = await tx.payment.create({
    data: {
      ...CREDIT_PAYMENT,
      orderId: input.orderId,
      amount: fromPaisa(input.amountPaisa),
      paidAt: now,
      receivedById: input.actorId,
      verifiedById: input.actorId,
      verifiedAt: now,
      note: input.note?.trim() || "Paid from store credit",
    },
    select: { id: true },
  });
  const entry = await tx.storeCreditEntry.create({
    data: { customerId: input.customerId, type: "USED", amount: fromPaisa(-input.amountPaisa), orderId: input.orderId, paymentId: payment.id, createdById: input.actorId, createdAt: now },
    select: { id: true },
  });
  await recomputeOrderDueAmount(tx, input.orderId);
  await writeAuditLogWith(tx, {
    actorId: input.actorId,
    action: "store_credit.use",
    entityType: "customer",
    entityId: input.customerId,
    before: { balance: fromPaisa(balancePaisa) },
    after: { entryId: entry.id, orderId: input.orderId, paymentId: payment.id, amount: fromPaisa(-input.amountPaisa), balance: fromPaisa(balancePaisa - input.amountPaisa) },
  });
  return { paymentId: payment.id, entryId: entry.id };
}

/** Credit spent on this order and not yet given back, per customer. */
async function netSpentOnOrder(tx: Prisma.TransactionClient, orderId: string): Promise<Map<string, number>> {
  const rows = await tx.storeCreditEntry.groupBy({ by: ["customerId"], where: { orderId, type: { in: ["USED", "RESTORED"] } }, _sum: { amount: true } });
  // USED rows are negative, RESTORED positive: what's still out is −sum.
  return new Map(rows.map((r) => [r.customerId, -toPaisa(r._sum.amount ?? 0)]).filter(([, paisa]) => (paisa as number) > 0) as [string, number][]);
}

/**
 * Gives back every bit of store credit spent on `orderId` — called when the
 * order is cancelled (lib/orders/lifecycle.ts), or to undo a use by
 * mistake. A −payment on the order and a +RESTORED ledger row per customer.
 * Returns what went back.
 */
export async function restoreStoreCreditForOrder(tx: Prisma.TransactionClient, input: { orderId: string; actorId: string | null; reason: string }): Promise<number> {
  const spent = await netSpentOnOrder(tx, input.orderId);
  let total = 0;
  for (const [customerId, paisa] of spent) {
    await lockCustomer(tx, customerId);
    const now = new Date();
    const expiresAt = await expiryForNewCredit(tx, now);
    const payment = await tx.payment.create({
      data: { ...CREDIT_PAYMENT, orderId: input.orderId, amount: fromPaisa(-paisa), paidAt: now, receivedById: input.actorId, verifiedById: input.actorId, verifiedAt: now, note: input.reason },
      select: { id: true },
    });
    const entry = await tx.storeCreditEntry.create({
      data: { customerId, type: "RESTORED", amount: fromPaisa(paisa), expiresAt, orderId: input.orderId, paymentId: payment.id, reason: input.reason, createdById: input.actorId, createdAt: now },
      select: { id: true },
    });
    await writeAuditLogWith(tx, {
      actorId: input.actorId,
      action: "store_credit.restore",
      entityType: "customer",
      entityId: customerId,
      after: { entryId: entry.id, orderId: input.orderId, paymentId: payment.id, amount: fromPaisa(paisa), reason: input.reason },
    });
    total += paisa;
  }
  if (total > 0) await recomputeOrderDueAmount(tx, input.orderId);
  return total;
}

/**
 * PRD §4.11 — Admin only (customer.credit.adjust): sets a balance right,
 * with a reason. A deduction can't take the balance below zero.
 */
export async function adjustStoreCredit(db: Db, input: { customerId: string; amount: number; reason: string; actorId: string; request?: Request }) {
  const amountPaisa = toPaisa(input.amount);
  const reason = input.reason.trim();
  if (amountPaisa === 0) throw new StoreCreditError("Enter an amount to add or take away.");
  if (reason.length < 3) throw new StoreCreditError("Give the reason for the adjustment.");
  return withTx(db, async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId }, select: { id: true, deletedAt: true } });
    if (!customer || customer.deletedAt) throw new StoreCreditError("Customer not found", 404);
    await lockCustomer(tx, input.customerId);
    const now = new Date();
    const { balancePaisa } = deriveStoreCredit(await ledgerRows(tx, { customerId: input.customerId }), now);
    if (amountPaisa < 0 && -amountPaisa > balancePaisa) {
      throw new StoreCreditError(`The balance is ${formatBDT(fromPaisa(balancePaisa))} — you can't take away more than that.`, 409);
    }
    const expiresAt = amountPaisa > 0 ? await expiryForNewCredit(tx, now) : null;
    const entry = await tx.storeCreditEntry.create({
      data: { customerId: input.customerId, type: "ADJUSTED", amount: fromPaisa(amountPaisa), expiresAt, reason, createdById: input.actorId, createdAt: now },
      select: { id: true },
    });
    await writeAuditLogWith(tx, {
      actorId: input.actorId,
      action: "store_credit.adjust",
      entityType: "customer",
      entityId: input.customerId,
      before: { balance: fromPaisa(balancePaisa) },
      after: { entryId: entry.id, amount: fromPaisa(amountPaisa), reason, balance: fromPaisa(balancePaisa + amountPaisa), expiresAt: expiresAt?.toISOString() ?? null },
      request: input.request,
    });
    return { entryId: entry.id, balance: fromPaisa(balancePaisa + amountPaisa) };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type StoreCreditLedgerRow = {
  id: string;
  type: "ISSUED" | "USED" | "RESTORED" | "ADJUSTED";
  amount: string;
  expiresAt: string | null;
  order: { id: string; orderNo: string } | null;
  reason: string | null;
  by: string | null;
  at: string;
};

export type StoreCreditSummary = {
  balance: string;
  /** Open credit with an expiry, soonest first. */
  expiring: { amount: string; expiresAt: string }[];
  entries: StoreCreditLedgerRow[];
};

export async function getStoreCreditSummary(db: Db, customerId: string): Promise<StoreCreditSummary> {
  const [derived, rows] = await Promise.all([
    getStoreCredit(db, customerId),
    db.storeCreditEntry.findMany({
      where: { customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        type: true,
        amount: true,
        expiresAt: true,
        reason: true,
        createdAt: true,
        order: { select: { id: true, orderNo: true } },
        createdBy: { select: { name: true } },
      },
    }),
  ]);
  return {
    balance: fromPaisa(derived.balancePaisa),
    expiring: derived.lots.filter((l) => l.expiresAt).map((l) => ({ amount: fromPaisa(l.remainingPaisa), expiresAt: l.expiresAt!.toISOString() })),
    entries: rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: r.amount.toFixed(2),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      order: r.order,
      reason: r.reason,
      by: r.createdBy?.name ?? null,
      at: r.createdAt.toISOString(),
    })),
  };
}

/** The whole shop's credit position for the collection report (PRD §4.12). */
export type StoreCreditPosition = {
  /** Owed to customers at the end of the period — a liability. */
  outstanding: string;
  customersWithCredit: number;
  issued: string;
  used: string;
  restored: string;
  adjusted: string;
  expired: string;
};

export async function getStoreCreditPosition(db: Db, from: Date, to: Date): Promise<StoreCreditPosition> {
  const rows = await db.storeCreditEntry.findMany({
    where: { createdAt: { lt: to } },
    select: { id: true, customerId: true, type: true, amount: true, createdAt: true, expiresAt: true },
  });
  const byCustomer = new Map<string, { id: string; amountPaisa: number; createdAt: Date; expiresAt: Date | null }[]>();
  const moved = { ISSUED: 0, USED: 0, RESTORED: 0, ADJUSTED: 0 };
  for (const r of rows) {
    const list = byCustomer.get(r.customerId) ?? [];
    list.push({ id: r.id, amountPaisa: toPaisa(r.amount), createdAt: r.createdAt, expiresAt: r.expiresAt });
    byCustomer.set(r.customerId, list);
    if (r.createdAt >= from) moved[r.type] += toPaisa(r.amount);
  }
  // The balance just before `to` — the period's last moment.
  const end = new Date(to.getTime() - 1);
  let outstanding = 0;
  let expired = 0;
  let customersWithCredit = 0;
  for (const list of byCustomer.values()) {
    const d = deriveStoreCredit(list, end);
    outstanding += d.balancePaisa;
    if (d.balancePaisa > 0) customersWithCredit += 1;
    expired += d.expiries.filter((e) => e.at >= from && e.at <= end).reduce((s, e) => s + e.paisa, 0);
  }
  return {
    outstanding: fromPaisa(outstanding),
    customersWithCredit,
    issued: fromPaisa(moved.ISSUED),
    used: fromPaisa(-moved.USED),
    restored: fromPaisa(moved.RESTORED),
    adjusted: fromPaisa(moved.ADJUSTED),
    expired: fromPaisa(expired),
  };
}

/**
 * The POS and the order form: a phone number's credit, when that number
 * is a customer. Only the balance — never the name or anything else (the
 * record may belong to another executive, PRD §4.7).
 */
export async function lookupStoreCreditByPhone(db: Db, normalizedPhone: string): Promise<{ known: boolean; balance: string }> {
  const customer = await db.customer.findUnique({ where: { phone: normalizedPhone }, select: { id: true, deletedAt: true } });
  if (!customer || customer.deletedAt) return { known: false, balance: "0.00" };
  return { known: true, balance: await getStoreCreditBalance(db, customer.id) };
}
