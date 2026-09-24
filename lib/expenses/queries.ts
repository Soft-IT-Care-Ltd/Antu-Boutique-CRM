import "server-only";

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import type { AdPlatformValue, ExpenseCategoryOption, ExpenseKindValue, ExpenseNatureValue } from "@/lib/expenses/constants";
import { expenseSource } from "@/lib/expenses/service";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { prisma } from "@/lib/prisma";

export type ExpenseListQuery = {
  q?: string;
  categoryId?: string;
  kind?: ExpenseKindValue;
  nature?: ExpenseNatureValue;
  walletId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

export type ExpenseListItem = {
  id: string;
  expenseDate: string;
  categoryId: string;
  categoryName: string;
  kind: ExpenseKindValue;
  nature: ExpenseNatureValue;
  amount: string;
  walletId: string | null;
  walletName: string | null;
  note: string | null;
  /** Set for expenses the system posted — they're changed at the source. */
  source: string | null;
  attachmentPath: string | null;
  attachmentName: string | null;
  attachmentMime: string | null;
  createdByName: string | null;
};

export async function listExpenseCategories(db: Db = prisma): Promise<ExpenseCategoryOption[]> {
  return db.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true, defaultNature: true, isSystem: true },
  });
}

function expenseWhere(query: Omit<ExpenseListQuery, "page" | "pageSize">): Prisma.ExpenseWhereInput {
  const and: Prisma.ExpenseWhereInput[] = [{ deletedAt: null }];
  if (query.categoryId) and.push({ categoryId: query.categoryId });
  if (query.kind) and.push({ category: { kind: query.kind } });
  if (query.nature) and.push({ nature: query.nature });
  if (query.walletId) and.push({ walletId: query.walletId });
  if (query.from) and.push({ expenseDate: { gte: query.from } });
  if (query.to) and.push({ expenseDate: { lt: query.to } });
  if (query.q) and.push({ OR: [{ note: { contains: query.q, mode: "insensitive" } }, { category: { name: { contains: query.q, mode: "insensitive" } } }] });
  return { AND: and };
}

export async function listExpenses(query: ExpenseListQuery): Promise<{ items: ExpenseListItem[]; total: number; totalAmount: string }> {
  const where = expenseWhere(query);
  const [total, sum, rows] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
    prisma.expense.findMany({
      where,
      orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        category: { select: { name: true, kind: true, isSystem: true } },
        wallet: { select: { name: true } },
        createdBy: { select: { name: true } },
        stockMovement: { select: { type: true } },
        statementDeliveryCharge: { select: { reference: true } },
        statementCodCharge: { select: { reference: true } },
        packagingOrder: { select: { orderNo: true } },
        exchangeCourierCase: { select: { replacementOrder: { select: { orderNo: true } } } },
      },
    }),
  ]);
  return {
    total,
    totalAmount: fromPaisa(toPaisa(sum._sum.amount ?? 0)),
    items: rows.map((e) => ({
      id: e.id,
      expenseDate: e.expenseDate.toISOString(),
      categoryId: e.categoryId,
      categoryName: e.category.name,
      kind: e.category.kind,
      nature: e.nature,
      amount: e.amount.toString(),
      walletId: e.walletId,
      walletName: e.wallet?.name ?? null,
      note: e.note,
      source: expenseSource(e),
      attachmentPath: e.attachmentPath,
      attachmentName: e.attachmentName,
      attachmentMime: e.attachmentMime,
      createdByName: e.createdBy?.name ?? null,
    })),
  };
}

export type AdSpendItem = {
  id: string;
  spendDate: string;
  platform: AdPlatformValue;
  amount: string;
  walletId: string;
  walletName: string;
  note: string | null;
  createdByName: string | null;
};

export async function listAdSpend(query: { from?: Date; to?: Date; page: number; pageSize: number }): Promise<{ items: AdSpendItem[]; total: number; totalAmount: string }> {
  const where: Prisma.DailyAdSpendWhereInput = {
    deletedAt: null,
    ...(query.from || query.to ? { spendDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
  };
  const [total, sum, rows] = await Promise.all([
    prisma.dailyAdSpend.count({ where }),
    prisma.dailyAdSpend.aggregate({ where, _sum: { amount: true } }),
    prisma.dailyAdSpend.findMany({
      where,
      orderBy: [{ spendDate: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { wallet: { select: { name: true } }, createdBy: { select: { name: true } } },
    }),
  ]);
  return {
    total,
    totalAmount: fromPaisa(toPaisa(sum._sum.amount ?? 0)),
    items: rows.map((a) => ({
      id: a.id,
      spendDate: a.spendDate.toISOString(),
      platform: a.platform,
      amount: a.amount.toString(),
      walletId: a.walletId,
      walletName: a.wallet.name,
      note: a.note,
      createdByName: a.createdBy?.name ?? null,
    })),
  };
}
