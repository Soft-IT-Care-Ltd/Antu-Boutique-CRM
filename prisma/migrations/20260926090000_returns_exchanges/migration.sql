-- P3.2 — returns and exchanges (PRD §4.11). A return_cases row per return
-- or exchange, its lines, the replacement order link
-- (orders.exchangedFromOrderId), and the exchange-credit payment kind.
-- The CHECKs that use the new PaymentKind/PaymentMethod value live in
-- 20260926090100: Postgres can't use an enum value in the transaction that
-- added it.

-- CreateEnum
CREATE TYPE "ReturnCaseType" AS ENUM ('RETURN', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "ReturnCaseMode" AS ENUM ('ONLINE', 'COUNTER');

-- CreateEnum
CREATE TYPE "ReturnCaseStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('WRONG_SIZE', 'WRONG_COLOR', 'NOT_AS_EXPECTED', 'DEFECTIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "CourierChargeBearer" AS ENUM ('CUSTOMER', 'COMPANY');

-- AlterEnum
ALTER TYPE "PaymentKind" ADD VALUE 'EXCHANGE_CREDIT';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'EXCHANGE_CREDIT';

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "exchangeCourierCaseId" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "exchangedFromOrderId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "returnCaseId" TEXT;

-- CreateTable
CREATE TABLE "return_cases" (
    "id" TEXT NOT NULL,
    "type" "ReturnCaseType" NOT NULL,
    "mode" "ReturnCaseMode" NOT NULL,
    "status" "ReturnCaseStatus" NOT NULL DEFAULT 'REQUESTED',
    "orderId" TEXT NOT NULL,
    "replacementOrderId" TEXT,
    "reason" "ReturnReason" NOT NULL,
    "reasonNote" TEXT,
    "courierChargeBearer" "CourierChargeBearer",
    "orderStatusBefore" "OrderStatus",
    "inspectionId" TEXT,
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelNote" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_case_lines" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "replacementVariantId" TEXT,

    CONSTRAINT "return_case_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_cases_replacementOrderId_key" ON "return_cases"("replacementOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "return_cases_inspectionId_key" ON "return_cases"("inspectionId");

-- CreateIndex
CREATE INDEX "return_cases_orderId_idx" ON "return_cases"("orderId");

-- CreateIndex
CREATE INDEX "return_cases_status_idx" ON "return_cases"("status");

-- CreateIndex
CREATE INDEX "return_cases_type_createdAt_idx" ON "return_cases"("type", "createdAt");

-- CreateIndex
CREATE INDEX "return_case_lines_replacementVariantId_idx" ON "return_case_lines"("replacementVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "return_case_lines_caseId_orderItemId_key" ON "return_case_lines"("caseId", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_exchangeCourierCaseId_key" ON "expenses"("exchangeCourierCaseId");

-- CreateIndex
CREATE INDEX "orders_exchangedFromOrderId_idx" ON "orders"("exchangedFromOrderId");

-- CreateIndex
CREATE INDEX "payments_returnCaseId_idx" ON "payments"("returnCaseId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_exchangedFromOrderId_fkey" FOREIGN KEY ("exchangedFromOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_returnCaseId_fkey" FOREIGN KEY ("returnCaseId") REFERENCES "return_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_exchangeCourierCaseId_fkey" FOREIGN KEY ("exchangeCourierCaseId") REFERENCES "return_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_replacementOrderId_fkey" FOREIGN KEY ("replacementOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "return_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_case_lines" ADD CONSTRAINT "return_case_lines_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "return_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_case_lines" ADD CONSTRAINT "return_case_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_case_lines" ADD CONSTRAINT "return_case_lines_replacementVariantId_fkey" FOREIGN KEY ("replacementVariantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Only an online exchange has a courier charge bearer; only an exchange has
-- a replacement order; a counter case is settled on the spot, so it only
-- ever exists COMPLETED.
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_bearer_chk"
  CHECK (("type" = 'EXCHANGE' AND "mode" = 'ONLINE') = ("courierChargeBearer" IS NOT NULL));
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_replacement_chk"
  CHECK ("type" = 'EXCHANGE' OR "replacementOrderId" IS NULL);
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_counter_chk"
  CHECK ("mode" = 'ONLINE' OR "status" = 'COMPLETED');
ALTER TABLE "return_case_lines" ADD CONSTRAINT "return_case_lines_qty_chk" CHECK ("qty" > 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_exchanged_from_other_chk"
  CHECK ("exchangedFromOrderId" IS NULL OR "exchangedFromOrderId" <> "id");
