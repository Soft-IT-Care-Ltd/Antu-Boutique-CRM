-- CreateEnum
CREATE TYPE "CourierStatementSource" AS ENUM ('STEADFAST_API', 'CSV_IMPORT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CourierStatementStatus" AS ENUM ('PROCESSING', 'PAID');

-- CreateEnum
CREATE TYPE "CourierStatementLineStatus" AS ENUM ('PENDING', 'MATCHED', 'MISMATCH', 'UNMATCHED', 'ACCEPTED', 'DISPUTED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'COURIER_COD';

-- AlterTable
ALTER TABLE "courier_integrations" ADD COLUMN     "lastPaymentsSyncAt" TIMESTAMP(3),
ADD COLUMN     "paymentsLastPage" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "courier_statements" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "source" "CourierStatementSource" NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "CourierStatementStatus" NOT NULL DEFAULT 'PAID',
    "statementDate" TIMESTAMP(3) NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "codCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "wallet" TEXT,
    "note" TEXT,
    "rawPayload" JSONB,
    "rawDetailPayload" JSONB,
    "reconciledAt" TIMESTAMP(3),
    "deliveryChargeExpenseId" TEXT,
    "codChargeExpenseId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_statement_lines" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "consignmentId" TEXT,
    "invoice" TEXT,
    "codAmount" DECIMAL(12,2) NOT NULL,
    "deliveryCharge" DECIMAL(12,2),
    "codCharge" DECIMAL(12,2),
    "shipmentId" TEXT,
    "orderId" TEXT,
    "status" "CourierStatementLineStatus" NOT NULL DEFAULT 'PENDING',
    "ourCod" DECIMAL(12,2),
    "expectedNet" DECIMAL(12,2),
    "paidNet" DECIMAL(12,2),
    "mismatchReason" TEXT,
    "paymentId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolveNote" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "courier_statements_deliveryChargeExpenseId_key" ON "courier_statements"("deliveryChargeExpenseId");

-- CreateIndex
CREATE UNIQUE INDEX "courier_statements_codChargeExpenseId_key" ON "courier_statements"("codChargeExpenseId");

-- CreateIndex
CREATE INDEX "courier_statements_statementDate_idx" ON "courier_statements"("statementDate");

-- CreateIndex
CREATE UNIQUE INDEX "courier_statements_courierId_reference_key" ON "courier_statements"("courierId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "courier_statement_lines_paymentId_key" ON "courier_statement_lines"("paymentId");

-- CreateIndex
CREATE INDEX "courier_statement_lines_shipmentId_idx" ON "courier_statement_lines"("shipmentId");

-- CreateIndex
CREATE INDEX "courier_statement_lines_orderId_idx" ON "courier_statement_lines"("orderId");

-- CreateIndex
CREATE INDEX "courier_statement_lines_status_idx" ON "courier_statement_lines"("status");

-- CreateIndex
CREATE UNIQUE INDEX "courier_statement_lines_statementId_lineNo_key" ON "courier_statement_lines"("statementId", "lineNo");

-- AddForeignKey
ALTER TABLE "courier_statements" ADD CONSTRAINT "courier_statements_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "courier_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statements" ADD CONSTRAINT "courier_statements_deliveryChargeExpenseId_fkey" FOREIGN KEY ("deliveryChargeExpenseId") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statements" ADD CONSTRAINT "courier_statements_codChargeExpenseId_fkey" FOREIGN KEY ("codChargeExpenseId") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statements" ADD CONSTRAINT "courier_statements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statement_lines" ADD CONSTRAINT "courier_statement_lines_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "courier_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statement_lines" ADD CONSTRAINT "courier_statement_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statement_lines" ADD CONSTRAINT "courier_statement_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statement_lines" ADD CONSTRAINT "courier_statement_lines_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statement_lines" ADD CONSTRAINT "courier_statement_lines_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

