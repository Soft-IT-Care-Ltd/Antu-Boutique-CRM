import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { Db } from "@/lib/db/tx";
import { toNumber } from "@/lib/money";
import { PAYMENT_METHOD_LABELS, type PaymentMethodValue } from "@/lib/orders/constants";
import { METHOD_WALLET_TYPES, WALLET_TYPE_LABELS, type WalletOption, type WalletTypeValue } from "@/lib/wallets/constants";

export class WalletError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Active wallets for pickers (payment, refund, expense, ad spend forms). Names only — no balances. */
export async function listWalletOptions(db: Db): Promise<WalletOption[]> {
  return db.wallet.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, type: true } });
}

/**
 * The wallet a payment (or refund) made by `method` goes into / comes out
 * of. An explicit choice must be an active wallet of a matching type; with
 * none given, the first active matching wallet is used. COURIER_COD never
 * has one — that money arrives as the courier statement's net payout.
 */
export async function resolvePaymentWalletId(db: Db, method: PaymentMethodValue, walletId: string | null | undefined): Promise<string | null> {
  const types = METHOD_WALLET_TYPES[method] as WalletTypeValue[];
  if (method === "COURIER_COD") {
    if (walletId) throw new WalletError("Courier COD reaches a wallet through the courier's payout, not per payment.");
    return null;
  }
  if (walletId) {
    const wallet = await db.wallet.findUnique({ where: { id: walletId }, select: { type: true, isActive: true, name: true } });
    if (!wallet || !wallet.isActive) throw new WalletError("Pick an active wallet.");
    if (!types.includes(wallet.type)) {
      throw new WalletError(`${wallet.name} is a ${WALLET_TYPE_LABELS[wallet.type]} wallet — it can't take a ${PAYMENT_METHOD_LABELS[method]} payment.`);
    }
    return walletId;
  }
  const fallback = await db.wallet.findFirst({ where: { isActive: true, type: { in: types } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true } });
  return fallback?.id ?? null;
}

/** An expense or ad spend is paid from any active wallet. */
export async function assertActiveWallet(db: Db, walletId: string): Promise<void> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId }, select: { isActive: true } });
  if (!wallet || !wallet.isActive) throw new WalletError("Pick an active wallet.");
}

// ---------------------------------------------------------------------------
// Wallet master
// ---------------------------------------------------------------------------

export type WalletInput = {
  name: string;
  type: WalletTypeValue;
  accountNo?: string | null;
  openingBalance: number;
  openingDate: Date;
  sortOrder?: number;
  note?: string | null;
};

const walletAuditShape = (w: { name: string; type: string; accountNo: string | null; openingBalance: Prisma.Decimal | number; openingDate: Date; isActive: boolean }) => ({
  name: w.name,
  type: w.type,
  accountNo: w.accountNo,
  openingBalance: toNumber(w.openingBalance),
  openingDate: w.openingDate.toISOString(),
  isActive: w.isActive,
});

export async function createWallet(tx: Prisma.TransactionClient, input: WalletInput, actorId: string) {
  const wallet = await tx.wallet.create({
    data: {
      name: input.name,
      type: input.type,
      accountNo: input.accountNo || null,
      openingBalance: input.openingBalance,
      openingDate: input.openingDate,
      sortOrder: input.sortOrder ?? 100,
      note: input.note || null,
    },
  });
  await writeAuditLogWith(tx, { actorId, action: "wallet.create", entityType: "wallet", entityId: wallet.id, after: walletAuditShape(wallet) });
  return wallet;
}

/**
 * The opening balance and date are sensitive: changing either moves every
 * balance and statement for this wallet. Audited with before/after. A wallet
 * that has history is deactivated, never deleted (FKs are RESTRICT).
 */
export async function updateWallet(tx: Prisma.TransactionClient, id: string, input: Partial<WalletInput> & { isActive?: boolean }, actorId: string) {
  const before = await tx.wallet.findUnique({ where: { id } });
  if (!before) throw new WalletError("Wallet not found", 404);
  if (input.type && input.type !== before.type) {
    const used = await tx.payment.count({ where: { walletId: id } });
    if (used > 0) throw new WalletError("This wallet already has payments — its type can't change.");
  }
  const after = await tx.wallet.update({
    where: { id },
    data: {
      name: input.name,
      type: input.type,
      accountNo: input.accountNo === undefined ? undefined : input.accountNo || null,
      openingBalance: input.openingBalance,
      openingDate: input.openingDate,
      sortOrder: input.sortOrder,
      note: input.note === undefined ? undefined : input.note || null,
      isActive: input.isActive,
    },
  });
  await writeAuditLogWith(tx, { actorId, action: "wallet.update", entityType: "wallet", entityId: id, before: walletAuditShape(before), after: walletAuditShape(after) });
  return after;
}

// ---------------------------------------------------------------------------
// Manual entries and transfers
// ---------------------------------------------------------------------------

export type ManualEntryInput = { walletId: string; direction: "IN" | "OUT"; amount: number; entryDate: Date; note: string };

export async function createManualEntry(tx: Prisma.TransactionClient, input: ManualEntryInput, actorId: string) {
  await assertActiveWallet(tx, input.walletId);
  const entry = await tx.walletEntry.create({
    data: {
      walletId: input.walletId,
      type: input.direction === "IN" ? "MANUAL_IN" : "MANUAL_OUT",
      amount: input.amount,
      entryDate: input.entryDate,
      note: input.note,
      createdById: actorId,
    },
  });
  await writeAuditLogWith(tx, {
    actorId,
    action: "wallet.entry.create",
    entityType: "wallet",
    entityId: input.walletId,
    after: { entryId: entry.id, type: entry.type, amount: input.amount, entryDate: input.entryDate.toISOString(), note: input.note },
  });
  return entry;
}

export type TransferInput = { fromWalletId: string; toWalletId: string; amount: number; entryDate: Date; note: string };

/** A transfer is two entries (out of one, into the other) sharing a transferId — written together or not at all. */
export async function createTransfer(tx: Prisma.TransactionClient, input: TransferInput, actorId: string) {
  if (input.fromWalletId === input.toWalletId) throw new WalletError("Pick two different wallets.");
  await assertActiveWallet(tx, input.fromWalletId);
  await assertActiveWallet(tx, input.toWalletId);
  const transferId = randomUUID();
  const common = { amount: input.amount, entryDate: input.entryDate, note: input.note, transferId, createdById: actorId };
  const out = await tx.walletEntry.create({ data: { ...common, walletId: input.fromWalletId, type: "TRANSFER_OUT" } });
  const into = await tx.walletEntry.create({ data: { ...common, walletId: input.toWalletId, type: "TRANSFER_IN" } });
  await writeAuditLogWith(tx, {
    actorId,
    action: "wallet.transfer.create",
    entityType: "wallet",
    entityId: input.fromWalletId,
    after: { transferId, from: input.fromWalletId, to: input.toWalletId, amount: input.amount, entryDate: input.entryDate.toISOString(), note: input.note, entryIds: [out.id, into.id] },
  });
  return { transferId, entries: [out, into] };
}

/** Voids an entry (both halves of a transfer). The row stays, flagged, with the reason. */
export async function voidWalletEntry(tx: Prisma.TransactionClient, entryId: string, reason: string, actorId: string) {
  const entry = await tx.walletEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new WalletError("Entry not found", 404);
  if (entry.voidedAt) throw new WalletError("This entry is already void.");
  const where = entry.transferId ? { transferId: entry.transferId } : { id: entry.id };
  const rows = await tx.walletEntry.findMany({ where });
  await tx.walletEntry.updateMany({ where, data: { voidedAt: new Date(), voidReason: reason } });
  await writeAuditLogWith(tx, {
    actorId,
    action: "wallet.entry.void",
    entityType: "wallet",
    entityId: entry.walletId,
    before: rows.map((r) => ({ entryId: r.id, walletId: r.walletId, type: r.type, amount: toNumber(r.amount), note: r.note })),
    after: { voidReason: reason },
  });
  return rows.length;
}
