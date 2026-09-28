import type { Prisma } from "@prisma/client";

import { orderNumberYearMonth } from "@/lib/orders/constants";

// C4 — running numbers for stock documents: TR-YYMM-NNNN (transfers),
// SC-YYMM-NNNN (stock counts). Same rule as order numbers (lib/orders/
// order-number.ts): call it inside the transaction that inserts the
// document — the upsert row-locks the month's counter until commit, so two
// documents can never be handed the same number.

export type DocumentKind = "TR" | "SC";

export async function nextDocumentNumber(tx: Prisma.TransactionClient, kind: DocumentKind, when: Date = new Date()): Promise<string> {
  const yearMonth = orderNumberYearMonth(when);
  const row = await tx.documentSequence.upsert({
    where: { kind_yearMonth: { kind, yearMonth } },
    create: { kind, yearMonth, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return `${kind}-${yearMonth}-${String(row.lastNumber).padStart(4, "0")}`;
}
