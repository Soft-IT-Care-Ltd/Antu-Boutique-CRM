-- C4 — CORRECTIONS.md items 2 and 3: stock transfers between locations,
-- stock in transit, and stock counts by scan.
--
-- Stock in transit counts in the variant's total but belongs to no
-- location: its ledger rows have "locationId" NULL, and the new
-- product_variants."inTransitQty" holds their sum. So
--   stockQty = sum(variant_stocks.qty) + inTransitQty = sum(all ledger rows).
-- The triggers and CHECKs that hold this live in the next migration
-- (20261004090100_stock_transfer_checks): they name the new enum values,
-- which Postgres can't use in the transaction that adds them.
-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockCountScope" AS ENUM ('FULL', 'SPOT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_SEND';
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_RECEIVE';
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSIT_WRITE_OFF';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockReferenceType" ADD VALUE 'TRANSFER';
ALTER TYPE "StockReferenceType" ADD VALUE 'STOCK_COUNT';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "inTransitQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_movements" ALTER COLUMN "locationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "document_sequences" (
    "kind" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("kind","yearMonth")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "transferNo" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "qtyRequested" INTEGER NOT NULL DEFAULT 0,
    "qtySent" INTEGER NOT NULL DEFAULT 0,
    "qtyScannedIn" INTEGER NOT NULL DEFAULT 0,
    "qtyReceived" INTEGER NOT NULL DEFAULT 0,
    "qtyFound" INTEGER NOT NULL DEFAULT 0,
    "qtyWrittenOff" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,2),

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_orders" (
    "transferId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "stock_transfer_orders_pkey" PRIMARY KEY ("transferId","orderId")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" TEXT NOT NULL,
    "countNo" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "scope" "StockCountScope" NOT NULL DEFAULT 'SPOT',
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdById" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "countedQty" INTEGER NOT NULL DEFAULT 0,
    "expectedQty" INTEGER,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_transferNo_key" ON "stock_transfers"("transferNo");

-- CreateIndex
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers"("status");

-- CreateIndex
CREATE INDEX "stock_transfers_fromLocationId_status_idx" ON "stock_transfers"("fromLocationId", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_toLocationId_status_idx" ON "stock_transfers"("toLocationId", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_createdAt_idx" ON "stock_transfers"("createdAt");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_variantId_idx" ON "stock_transfer_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_transferId_variantId_key" ON "stock_transfer_lines"("transferId", "variantId");

-- CreateIndex
CREATE INDEX "stock_transfer_orders_orderId_idx" ON "stock_transfer_orders"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_countNo_key" ON "stock_counts"("countNo");

-- CreateIndex
CREATE INDEX "stock_counts_locationId_status_idx" ON "stock_counts"("locationId", "status");

-- CreateIndex
CREATE INDEX "stock_counts_createdAt_idx" ON "stock_counts"("createdAt");

-- CreateIndex
CREATE INDEX "stock_count_lines_variantId_idx" ON "stock_count_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_lines_countId_variantId_key" ON "stock_count_lines"("countId", "variantId");

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_orders" ADD CONSTRAINT "stock_transfer_orders_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_orders" ADD CONSTRAINT "stock_transfer_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_countId_fkey" FOREIGN KEY ("countId") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

