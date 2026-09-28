import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { AD_COST_CATEGORY_ID, AD_PLATFORM_LABELS, type AdPlatformValue, type ExpenseNatureValue } from "@/lib/expenses/constants";
import { toNumber } from "@/lib/money";
import { assertActiveWallet } from "@/lib/wallets/service";

// PRD §4.12 — daily expense entry, and daily ad spend. CLAUDE.md rule 7:
// every change here is audit-logged; rule 8: soft delete only.
//
// Expenses the system posted itself — a stock write-off, a courier return
// charge, a courier statement's charges, a day's ad spend, a drawer count,
// packaging used, a company-borne exchange courier charge — are changed at
// their source, never on the expense screen, so they can't drift from it.

export class ExpenseError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const SOURCE_INCLUDE = {
  stockMovement: { select: { type: true } },
  statementDeliveryCharge: { select: { reference: true } },
  statementCodCharge: { select: { reference: true } },
  packagingOrder: { select: { orderNo: true } },
  exchangeCourierCase: { select: { replacementOrder: { select: { orderNo: true } } } },
  category: { select: { isSystem: true } },
} satisfies Prisma.ExpenseInclude;

type ExpenseWithSource = Prisma.ExpenseGetPayload<{ include: typeof SOURCE_INCLUDE }>;

/** Where a system-posted expense came from, or null for a hand-entered one. */
export function expenseSource(e: ExpenseWithSource): string | null {
  if (e.adSpendId) return "Ad spend";
  if (e.stockMovement) {
    if (e.stockMovement.type === "TRANSIT_WRITE_OFF") return "Stock missing in transit";
    return e.stockMovement.type === "ADJUSTMENT" ? "Stock count adjustment" : "Stock write-off";
  }
  if (e.returnChargeInspectionId) return "Courier return check";
  if (e.statementDeliveryCharge) return `Courier statement ${e.statementDeliveryCharge.reference}`;
  if (e.statementCodCharge) return `Courier statement ${e.statementCodCharge.reference}`;
  if (e.cashDrawerId) return "the cash drawer count";
  if (e.packagingOrder) return `packaging used on ${e.packagingOrder.orderNo}`;
  if (e.exchangeCourierCase) return `the exchange courier charge${e.exchangeCourierCase.replacementOrder ? ` on ${e.exchangeCourierCase.replacementOrder.orderNo}` : ""}`;
  // A system category can't be picked by hand, so anything in one was posted.
  if (e.category.isSystem) return "the system";
  return null;
}

const auditShape = (e: { expenseDate: Date; categoryId: string; nature: string; amount: Prisma.Decimal | number; walletId: string | null; note: string | null }) => ({
  expenseDate: e.expenseDate.toISOString(),
  categoryId: e.categoryId,
  nature: e.nature,
  amount: toNumber(e.amount),
  walletId: e.walletId,
  note: e.note,
});

export type ExpenseInput = {
  expenseDate: Date;
  categoryId: string;
  nature: ExpenseNatureValue;
  amount: number;
  walletId: string;
  note?: string | null;
};

async function assertPickableCategory(tx: Prisma.TransactionClient, categoryId: string) {
  const category = await tx.expenseCategory.findUnique({ where: { id: categoryId } });
  if (!category || !category.isActive) throw new ExpenseError("Pick a category.");
  if (category.isSystem) {
    throw new ExpenseError(
      category.id === AD_COST_CATEGORY_ID ? "Ad cost is entered on the Ad spend screen, so it's allocated to orders." : `"${category.name}" is posted automatically — it can't be entered by hand.`,
    );
  }
}

async function loadEditable(tx: Prisma.TransactionClient, id: string) {
  const expense = await tx.expense.findFirst({ where: { id, deletedAt: null }, include: SOURCE_INCLUDE });
  if (!expense) throw new ExpenseError("Expense not found", 404);
  const source = expenseSource(expense);
  if (source) throw new ExpenseError(`This expense was posted by ${source} — change it there.`, 409);
  return expense;
}

export async function createExpense(tx: Prisma.TransactionClient, input: ExpenseInput, actorId: string) {
  await assertPickableCategory(tx, input.categoryId);
  await assertActiveWallet(tx, input.walletId);
  const expense = await tx.expense.create({
    data: {
      expenseDate: input.expenseDate,
      categoryId: input.categoryId,
      nature: input.nature,
      amount: input.amount,
      walletId: input.walletId,
      note: input.note || null,
      createdById: actorId,
    },
  });
  await writeAuditLogWith(tx, { actorId, action: "expense.create", entityType: "expense", entityId: expense.id, after: auditShape(expense) });
  return expense;
}

export async function updateExpense(tx: Prisma.TransactionClient, id: string, input: Partial<ExpenseInput>, actorId: string) {
  const before = await loadEditable(tx, id);
  if (input.categoryId && input.categoryId !== before.categoryId) await assertPickableCategory(tx, input.categoryId);
  if (input.walletId && input.walletId !== before.walletId) await assertActiveWallet(tx, input.walletId);
  const after = await tx.expense.update({
    where: { id },
    data: {
      expenseDate: input.expenseDate,
      categoryId: input.categoryId,
      nature: input.nature,
      amount: input.amount,
      walletId: input.walletId,
      note: input.note === undefined ? undefined : input.note || null,
    },
  });
  await writeAuditLogWith(tx, { actorId, action: "expense.edit", entityType: "expense", entityId: id, before: auditShape(before), after: auditShape(after) });
  return after;
}

export async function deleteExpense(tx: Prisma.TransactionClient, id: string, actorId: string) {
  const before = await loadEditable(tx, id);
  await tx.expense.update({ where: { id }, data: { deletedAt: new Date() } });
  await writeAuditLogWith(tx, { actorId, action: "expense.delete", entityType: "expense", entityId: id, before: auditShape(before) });
}

export type AttachmentInput = { path: string; mime: string; name: string };

/** Sets (or, with null, clears) the receipt. Returns the path it replaced so the caller can remove the old file. */
export async function setExpenseAttachment(tx: Prisma.TransactionClient, id: string, attachment: AttachmentInput | null, actorId: string): Promise<string | null> {
  const before = await tx.expense.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ExpenseError("Expense not found", 404);
  await tx.expense.update({
    where: { id },
    data: { attachmentPath: attachment?.path ?? null, attachmentMime: attachment?.mime ?? null, attachmentName: attachment?.name ?? null },
  });
  await writeAuditLogWith(tx, {
    actorId,
    action: attachment ? "expense.attachment.set" : "expense.attachment.delete",
    entityType: "expense",
    entityId: id,
    before: { attachmentPath: before.attachmentPath, attachmentName: before.attachmentName },
    after: { attachmentPath: attachment?.path ?? null, attachmentName: attachment?.name ?? null },
  });
  return before.attachmentPath;
}

// ---------------------------------------------------------------------------
// Daily ad spend — each row posts exactly one "Ad cost" expense
// ---------------------------------------------------------------------------

export type AdSpendInput = { spendDate: Date; platform: AdPlatformValue; amount: number; walletId: string; note?: string | null };

const adNote = (input: { platform: AdPlatformValue; note?: string | null }) =>
  [`Ad spend — ${AD_PLATFORM_LABELS[input.platform]}`, input.note?.trim()].filter(Boolean).join(" · ");

const adAuditShape = (a: { spendDate: Date; platform: string; amount: Prisma.Decimal | number; walletId: string; note: string | null }) => ({
  spendDate: a.spendDate.toISOString(),
  platform: a.platform,
  amount: toNumber(a.amount),
  walletId: a.walletId,
  note: a.note,
});

export async function createAdSpend(tx: Prisma.TransactionClient, input: AdSpendInput, actorId: string) {
  await assertActiveWallet(tx, input.walletId);
  const spend = await tx.dailyAdSpend.create({
    data: { spendDate: input.spendDate, platform: input.platform, amount: input.amount, walletId: input.walletId, note: input.note || null, createdById: actorId },
  });
  await tx.expense.create({
    data: {
      expenseDate: input.spendDate,
      categoryId: AD_COST_CATEGORY_ID,
      nature: "VARIABLE",
      amount: input.amount,
      walletId: input.walletId,
      note: adNote(input),
      adSpendId: spend.id,
      createdById: actorId,
    },
  });
  await writeAuditLogWith(tx, { actorId, action: "ad_spend.create", entityType: "daily_ad_spend", entityId: spend.id, after: adAuditShape(spend) });
  return spend;
}

export async function updateAdSpend(tx: Prisma.TransactionClient, id: string, input: Partial<AdSpendInput>, actorId: string) {
  const before = await tx.dailyAdSpend.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ExpenseError("Ad spend not found", 404);
  if (input.walletId && input.walletId !== before.walletId) await assertActiveWallet(tx, input.walletId);
  const after = await tx.dailyAdSpend.update({
    where: { id },
    data: { spendDate: input.spendDate, platform: input.platform, amount: input.amount, walletId: input.walletId, note: input.note === undefined ? undefined : input.note || null },
  });
  // The posted expense follows its source row exactly.
  await tx.expense.update({
    where: { adSpendId: id },
    data: { expenseDate: after.spendDate, amount: after.amount, walletId: after.walletId, note: adNote({ platform: after.platform, note: after.note }) },
  });
  await writeAuditLogWith(tx, { actorId, action: "ad_spend.edit", entityType: "daily_ad_spend", entityId: id, before: adAuditShape(before), after: adAuditShape(after) });
  return after;
}

export async function deleteAdSpend(tx: Prisma.TransactionClient, id: string, actorId: string) {
  const before = await tx.dailyAdSpend.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new ExpenseError("Ad spend not found", 404);
  const now = new Date();
  await tx.dailyAdSpend.update({ where: { id }, data: { deletedAt: now } });
  await tx.expense.update({ where: { adSpendId: id }, data: { deletedAt: now } });
  await writeAuditLogWith(tx, { actorId, action: "ad_spend.delete", entityType: "daily_ad_spend", entityId: id, before: adAuditShape(before) });
}
