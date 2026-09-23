import "server-only";

import { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { prisma } from "@/lib/prisma";
import type { WalletFlowSource, WalletTypeValue } from "@/lib/wallets/constants";

// PRD §4.10: wallets with running balances and a statement per date range.
//
// A wallet stores no balance. Every figure here is derived from the rows
// that moved the money, so a balance can never drift from its history:
//
//   + verified payments received into it     (unverified ones are "pending")
//   − APPROVED refunds paid out of it        (stored negative)
//   − expenses paid from it                  (not deleted)
//   ± manual entries and transfers           (not voided)
//   + courier payouts (statement net) into it, once the courier has PAID
//
// COURIER_COD payments carry no wallet (DB CHECK) and courier charges the
// courier deducted carry none either: the payout's net is what reached the
// bank. Only money dated on/after the wallet's openingDate counts — anything
// earlier is already inside the opening balance.

const flowsSql = Prisma.sql`
  SELECT p."walletId" AS "walletId", p."paidAt" AS "at", p."amount" AS "amount",
         CASE WHEN p."kind" = 'REFUND' THEN 'REFUND' ELSE 'PAYMENT' END AS "source",
         p."id" AS "sourceId", o."orderNo" AS "reference", o."id" AS "orderId", p."note" AS "note"
    FROM "payments" p JOIN "orders" o ON o."id" = p."orderId"
   WHERE p."walletId" IS NOT NULL
     AND ((p."kind" = 'PAYMENT' AND p."verified") OR (p."kind" = 'REFUND' AND p."refundStatus" = 'APPROVED'))
  UNION ALL
  SELECT e."walletId", e."expenseDate", -e."amount", 'EXPENSE', e."id", c."name", NULL, e."note"
    FROM "expenses" e JOIN "expense_categories" c ON c."id" = e."categoryId"
   WHERE e."walletId" IS NOT NULL AND e."deletedAt" IS NULL
  UNION ALL
  SELECT we."walletId", we."entryDate",
         CASE WHEN we."type" IN ('MANUAL_IN', 'TRANSFER_IN') THEN we."amount" ELSE -we."amount" END,
         'ENTRY', we."id", we."type"::text, NULL, we."note"
    FROM "wallet_entries" we
   WHERE we."voidedAt" IS NULL
  UNION ALL
  SELECT s."walletId", s."statementDate", s."netAmount", 'COURIER_PAYOUT', s."id", s."reference", NULL, NULL
    FROM "courier_statements" s
   WHERE s."walletId" IS NOT NULL AND s."status" = 'PAID'
`;

export type WalletBalance = {
  id: string;
  name: string;
  type: WalletTypeValue;
  accountNo: string | null;
  isActive: boolean;
  openingBalance: string;
  openingDate: string;
  balance: string;
  /** Payments recorded into this wallet that Accounts hasn't verified yet. */
  pendingVerification: string;
  pendingVerificationCount: number;
};

type BalanceRow = {
  id: string;
  name: string;
  type: WalletTypeValue;
  accountNo: string | null;
  isActive: boolean;
  openingBalance: Prisma.Decimal;
  openingDate: Date;
  flow: Prisma.Decimal | null;
  pending: Prisma.Decimal | null;
  pendingCount: bigint;
};

export async function getWalletBalances(db: Db = prisma, opts: { walletId?: string } = {}): Promise<WalletBalance[]> {
  const only = opts.walletId ? Prisma.sql`WHERE w."id" = ${opts.walletId}` : Prisma.empty;
  const rows = await db.$queryRaw<BalanceRow[]>`
    WITH flows AS (${flowsSql})
    SELECT w."id", w."name", w."type", w."accountNo", w."isActive", w."openingBalance", w."openingDate",
           (SELECT SUM(f."amount") FROM flows f WHERE f."walletId" = w."id" AND f."at" >= w."openingDate") AS "flow",
           (SELECT SUM(p."amount") FROM "payments" p
             WHERE p."walletId" = w."id" AND p."kind" = 'PAYMENT' AND NOT p."verified") AS "pending",
           (SELECT COUNT(*) FROM "payments" p
             WHERE p."walletId" = w."id" AND p."kind" = 'PAYMENT' AND NOT p."verified") AS "pendingCount"
      FROM "wallets" w
      ${only}
     ORDER BY w."isActive" DESC, w."sortOrder", w."name"`;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    accountNo: r.accountNo,
    isActive: r.isActive,
    openingBalance: fromPaisa(toPaisa(r.openingBalance)),
    openingDate: r.openingDate.toISOString(),
    balance: fromPaisa(toPaisa(r.openingBalance) + toPaisa(r.flow ?? 0)),
    pendingVerification: fromPaisa(toPaisa(r.pending ?? 0)),
    pendingVerificationCount: Number(r.pendingCount),
  }));
}

export type WalletStatementRow = {
  at: string;
  source: WalletFlowSource;
  sourceId: string;
  /** Order no., expense category, entry type or courier statement reference. */
  reference: string | null;
  orderId: string | null;
  note: string | null;
  amount: string;
  balance: string;
};

export type WalletStatement = {
  wallet: WalletBalance;
  from: string;
  to: string;
  openingBalance: string;
  moneyIn: string;
  moneyOut: string;
  closingBalance: string;
  rows: WalletStatementRow[];
  truncated: boolean;
};

type FlowRow = {
  at: Date;
  amount: Prisma.Decimal;
  source: WalletFlowSource;
  sourceId: string;
  reference: string | null;
  orderId: string | null;
  note: string | null;
};

const STATEMENT_ROW_LIMIT = 2000;

/**
 * Statement for [from, to) — UTC instants, normally Dhaka day boundaries.
 * Opening = the wallet's opening balance + everything from its openingDate
 * up to `from`; each row carries the running balance after it.
 */
export async function getWalletStatement(db: Db, walletId: string, from: Date, to: Date): Promise<WalletStatement | null> {
  const [wallet] = await getWalletBalances(db, { walletId });
  if (!wallet) return null;
  const openingDate = new Date(wallet.openingDate);
  const start = from > openingDate ? from : openingDate;

  const [before] = await db.$queryRaw<{ total: Prisma.Decimal | null }[]>`
    WITH flows AS (${flowsSql})
    SELECT SUM("amount") AS "total" FROM flows
     WHERE "walletId" = ${walletId} AND "at" >= ${openingDate} AND "at" < ${start}`;
  const [range] = await db.$queryRaw<{ moneyIn: Prisma.Decimal | null; moneyOut: Prisma.Decimal | null }[]>`
    WITH flows AS (${flowsSql})
    SELECT SUM(CASE WHEN "amount" > 0 THEN "amount" END) AS "moneyIn", SUM(CASE WHEN "amount" < 0 THEN -"amount" END) AS "moneyOut"
      FROM flows
     WHERE "walletId" = ${walletId} AND "at" >= ${start} AND "at" < ${to}`;
  const flows = await db.$queryRaw<FlowRow[]>`
    WITH flows AS (${flowsSql})
    SELECT "at", "amount", "source", "sourceId", "reference", "orderId", "note" FROM flows
     WHERE "walletId" = ${walletId} AND "at" >= ${start} AND "at" < ${to}
     ORDER BY "at", "sourceId"
     LIMIT ${STATEMENT_ROW_LIMIT + 1}`;

  const truncated = flows.length > STATEMENT_ROW_LIMIT;
  const openingPaisa = toPaisa(wallet.openingBalance) + toPaisa(before?.total ?? 0);
  // Totals come from SQL so they stay exact even when the rows are capped.
  const inPaisa = toPaisa(range?.moneyIn ?? 0);
  const outPaisa = toPaisa(range?.moneyOut ?? 0);
  let running = openingPaisa;
  const rows = flows.slice(0, STATEMENT_ROW_LIMIT).map((f) => {
    const amount = toPaisa(f.amount);
    running += amount;
    return {
      at: f.at.toISOString(),
      source: f.source,
      sourceId: f.sourceId,
      reference: f.reference,
      orderId: f.orderId,
      note: f.note,
      amount: fromPaisa(amount),
      balance: fromPaisa(running),
    };
  });

  return {
    wallet,
    from: from.toISOString(),
    to: to.toISOString(),
    openingBalance: fromPaisa(openingPaisa),
    moneyIn: fromPaisa(inPaisa),
    moneyOut: fromPaisa(outPaisa),
    closingBalance: fromPaisa(openingPaisa + inPaisa - outPaisa),
    rows,
    truncated,
  };
}
