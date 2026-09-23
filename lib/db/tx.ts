import type { Prisma, PrismaClient } from "@prisma/client";

// Services that span several transactions (a courier API call must never
// sit inside one) take a `Db` instead of importing the prisma singleton. In
// the app that's `prisma`, and each step opens its own transaction; in an
// integration test it's the rolled-back test transaction
// (lib/test/rollback.ts), and every step simply runs inside it — so the whole
// flow is exercised against the real schema and leaves nothing behind.

export type Db = PrismaClient | Prisma.TransactionClient;

export function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>, timeout = 30_000): Promise<T> {
  // A transaction client has no usable $transaction (Prisma denies it), so
  // this tells the root client and a tx apart without a type tag.
  const root = db as PrismaClient;
  if (typeof root.$transaction === "function") return root.$transaction(fn, { timeout });
  return fn(db as Prisma.TransactionClient);
}
