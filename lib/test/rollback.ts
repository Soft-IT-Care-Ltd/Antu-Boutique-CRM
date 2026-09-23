import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// Integration tests that touch stock run entirely inside a transaction that
// is always rolled back. The stock ledger is append-only (a DB trigger
// rejects DELETE), so "clean up afterwards" is no longer possible — and
// rolling back leaves the shared dev database exactly as it was.

class RollbackSignal extends Error {}

export async function inRolledBackTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        result = await fn(tx);
        throw new RollbackSignal();
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  return result as T;
}

/**
 * Fires the deferred stock/ledger consistency triggers right now, as if the
 * transaction were committing — without ending it. Throws exactly what a
 * real COMMIT would. Re-defers afterwards so the next stock write can still
 * put its UPDATE and INSERT in either order.
 */
export async function checkDeferredConstraintsNow(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
}
