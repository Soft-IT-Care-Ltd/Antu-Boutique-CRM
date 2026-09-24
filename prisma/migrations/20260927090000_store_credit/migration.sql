-- P3.2 — store credit (PRD §4.11, §4.12). A per-customer ledger; the
-- balance is always derived from it, never stored. The CHECKs that use the
-- new enum values are in 20260927090100 (Postgres can't use an enum value
-- in the transaction that added it).
-- CreateEnum
CREATE TYPE "ReturnSettlement" AS ENUM ('REFUND', 'STORE_CREDIT');

-- CreateEnum
CREATE TYPE "StoreCreditEntryType" AS ENUM ('ISSUED', 'USED', 'RESTORED', 'ADJUSTED');

-- AlterEnum
ALTER TYPE "PaymentKind" ADD VALUE 'STORE_CREDIT';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'STORE_CREDIT';

-- AlterTable
ALTER TABLE "return_cases" ADD COLUMN     "settlement" "ReturnSettlement" NOT NULL DEFAULT 'REFUND';

-- CreateTable
CREATE TABLE "store_credit_entries" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "StoreCreditEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "orderId" TEXT,
    "paymentId" TEXT,
    "returnCaseId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_credit_entries_paymentId_key" ON "store_credit_entries"("paymentId");

-- CreateIndex
CREATE INDEX "store_credit_entries_customerId_createdAt_idx" ON "store_credit_entries"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "store_credit_entries_createdAt_idx" ON "store_credit_entries"("createdAt");

-- CreateIndex
CREATE INDEX "store_credit_entries_orderId_idx" ON "store_credit_entries"("orderId");

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_returnCaseId_fkey" FOREIGN KEY ("returnCaseId") REFERENCES "return_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

