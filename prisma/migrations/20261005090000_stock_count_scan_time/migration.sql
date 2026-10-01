-- AlterTable
ALTER TABLE "stock_count_lines" ADD COLUMN     "stockAtScan" INTEGER;

-- AlterTable
ALTER TABLE "stock_counts" ADD COLUMN     "openedAtSeq" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_seq_key" ON "stock_movements"("seq");

-- CreateIndex
CREATE INDEX "stock_movements_locationId_variantId_seq_idx" ON "stock_movements"("locationId", "variantId", "seq");


-- Counts already open: every movement so far counts as before they opened.
-- (Their lines have no stockAtScan; posting compares those with the stock
-- at posting, as before.)
UPDATE "stock_counts" SET "openedAtSeq" = COALESCE((SELECT MAX("seq") FROM "stock_movements"), 0) WHERE "status" = 'OPEN';
