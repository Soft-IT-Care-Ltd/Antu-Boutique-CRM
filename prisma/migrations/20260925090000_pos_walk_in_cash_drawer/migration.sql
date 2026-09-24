-- CreateEnum
CREATE TYPE "CashDrawerStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "ExpenseKind" ADD VALUE 'CASH_OVER_SHORT' BEFORE 'MISC';

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "cashDrawerId" TEXT;

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "customerId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "cash_drawers" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "businessDay" TIMESTAMP(3) NOT NULL,
    "status" "CashDrawerStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT,
    "openingCount" DECIMAL(12,2) NOT NULL,
    "openingDenominations" JSONB,
    "openingNote" TEXT,
    "bookBalanceAtOpen" DECIMAL(12,2) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closingCount" DECIMAL(12,2),
    "closingDenominations" JSONB,
    "expectedClose" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "closeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_drawers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_drawers_status_idx" ON "cash_drawers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_drawers_walletId_businessDay_key" ON "cash_drawers"("walletId", "businessDay");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_cashDrawerId_key" ON "expenses"("cashDrawerId");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cashDrawerId_fkey" FOREIGN KEY ("cashDrawerId") REFERENCES "cash_drawers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- PRD §4.6 / §4.7: every ONLINE order has its one person; only a walk-in
-- (POS) sale may be anonymous.
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_required_online_chk"
  CHECK ("channel" = 'WALK_IN' OR "customerId" IS NOT NULL);

-- A drawer is either open (nothing about its close recorded yet) or closed
-- with its count, the frozen expected figure and the difference between them.
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_close_fields_chk"
  CHECK (
    ("status" = 'OPEN' AND "closedAt" IS NULL AND "closingCount" IS NULL AND "expectedClose" IS NULL AND "difference" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closingCount" IS NOT NULL AND "expectedClose" IS NOT NULL
        AND "difference" = "closingCount" - "expectedClose")
  );
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_counts_nonneg_chk"
  CHECK ("openingCount" >= 0 AND ("closingCount" IS NULL OR "closingCount" >= 0));

-- One open drawer per wallet at a time: yesterday's must be closed before
-- today's opens, so no cash sale can land in a day nobody will count.
CREATE UNIQUE INDEX "cash_drawers_one_open_per_wallet" ON "cash_drawers"("walletId") WHERE "status" = 'OPEN';
