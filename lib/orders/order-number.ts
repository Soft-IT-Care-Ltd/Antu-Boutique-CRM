import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { orderNumberYearMonth } from "@/lib/orders/constants";

type TxClient = Prisma.TransactionClient | PrismaClient;

// AB-YYMM-NNNN (CLAUDE.md conventions). Must run inside the same
// transaction as the order insert: the upsert row-locks order_sequences for
// that month until the transaction commits, so two concurrent order
// creations in the same month can never be handed the same number.
export async function generateOrderNumber(tx: TxClient, when: Date = new Date()): Promise<string> {
  const yearMonth = orderNumberYearMonth(when);
  const sequence = await tx.orderSequence.upsert({
    where: { yearMonth },
    create: { yearMonth, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return `AB-${yearMonth}-${String(sequence.lastNumber).padStart(4, "0")}`;
}
