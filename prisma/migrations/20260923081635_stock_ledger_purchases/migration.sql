-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE_IN', 'SALE_OUT', 'RETURN_IN', 'EXCHANGE_OUT', 'EXCHANGE_IN', 'DAMAGE_OUT', 'ADJUSTMENT', 'POS_SALE_OUT');

-- CreateEnum
CREATE TYPE "StockReferenceType" AS ENUM ('OPENING_BALANCE', 'PURCHASE', 'ORDER', 'ADJUSTMENT', 'DAMAGE', 'RETURN', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "CostAllocationMethod" AS ENUM ('BY_VALUE', 'BY_QTY');

-- CreateEnum
CREATE TYPE "ExpenseNature" AS ENUM ('FIXED', 'VARIABLE');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "invoiceNo" TEXT,
    "allocationMethod" "CostAllocationMethod" NOT NULL DEFAULT 'BY_VALUE',
    "itemsSubtotal" DECIMAL(12,2) NOT NULL,
    "transportCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "amountPaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "dueAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "lineCost" DECIMAL(12,2) NOT NULL,
    "allocatedCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "landedUnitCost" DECIMAL(12,2) NOT NULL,
    "stockBefore" INTEGER NOT NULL,
    "wacBefore" DECIMAL(12,2) NOT NULL,
    "wacAfter" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "unitCostSnapshot" DECIMAL(12,2) NOT NULL,
    "referenceType" "StockReferenceType" NOT NULL,
    "referenceId" TEXT,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "nature" "ExpenseNature" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "stockMovementId" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

-- CreateIndex
CREATE INDEX "purchases_purchaseDate_idx" ON "purchases"("purchaseDate");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_supplierId_invoiceNo_key" ON "purchases"("supplierId", "invoiceNo");

-- CreateIndex
CREATE INDEX "purchase_items_purchaseId_idx" ON "purchase_items"("purchaseId");

-- CreateIndex
CREATE INDEX "purchase_items_variantId_idx" ON "purchase_items"("variantId");

-- CreateIndex
CREATE INDEX "stock_movements_variantId_createdAt_idx" ON "stock_movements"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_referenceType_referenceId_idx" ON "stock_movements"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "stock_movements_type_idx" ON "stock_movements"("type");

-- CreateIndex
CREATE INDEX "stock_movements_createdAt_idx" ON "stock_movements"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_name_key" ON "expense_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_stockMovementId_key" ON "expenses"("stockMovementId");

-- CreateIndex
CREATE INDEX "expenses_expenseDate_idx" ON "expenses"("expenseDate");

-- CreateIndex
CREATE INDEX "expenses_categoryId_idx" ON "expenses"("categoryId");

-- CreateIndex
CREATE INDEX "expenses_deletedAt_idx" ON "expenses"("deletedAt");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written below this line (P2.1). Prisma can't express any of it.
-- ---------------------------------------------------------------------------

-- 1. Opening balance. Stock that existed before the ledger went live (seed
--    data, variants packed in Phase 1) gets one ADJUSTMENT row per variant so
--    sum(stock_movements.qty) = stockQty holds from the first moment the
--    consistency trigger below exists. Deterministic ids, so it is obvious
--    in the ledger which rows came from this backfill.
INSERT INTO "stock_movements"
  ("id", "variantId", "type", "qty", "stockAfter", "unitCostSnapshot", "referenceType", "referenceId", "note", "actorId", "createdAt")
SELECT
  'opening_' || v."id", v."id", 'ADJUSTMENT', v."stockQty", v."stockQty", v."weightedAvgCost",
  'OPENING_BALANCE', NULL, 'Opening balance — stock on hand when the ledger went live', NULL, CURRENT_TIMESTAMP
FROM "product_variants" v
WHERE v."stockQty" <> 0;

-- 2. Immutable, append-only ledger (PRD §4.3). Corrections are new rows.
CREATE FUNCTION stock_movements_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION stock_movements_reject_change();

CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_reject_change();

-- 3. Stock and ledger can never diverge (CLAUDE.md rule 2 / PRD §6 inv. 2).
--    Deferred to COMMIT so a stock change and its ledger row can be written
--    in either order inside one transaction — but a transaction that writes
--    only one of the two cannot commit. Re-reads the live row rather than
--    trusting NEW, because a deferred trigger's NEW is the row as of the
--    event, not as of commit.
CREATE FUNCTION assert_variant_stock_matches_ledger() RETURNS trigger AS $$
DECLARE
  v_id TEXT;
  v_stock INTEGER;
  v_ledger BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'stock_movements' THEN
    v_id := NEW."variantId";
  ELSE
    v_id := NEW."id";
  END IF;

  SELECT "stockQty" INTO v_stock FROM "product_variants" WHERE "id" = v_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("qty"), 0) INTO v_ledger FROM "stock_movements" WHERE "variantId" = v_id;

  IF v_stock <> v_ledger THEN
    RAISE EXCEPTION 'stock/ledger divergence on variant %: stockQty = %, sum(stock_movements.qty) = %', v_id, v_stock, v_ledger
      USING ERRCODE = 'check_violation',
            HINT = 'Change stock only through recordStockMovement (lib/inventory/ledger.ts).';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER product_variants_stock_matches_ledger
  AFTER INSERT OR UPDATE OF "stockQty" ON "product_variants"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_variant_stock_matches_ledger();

CREATE CONSTRAINT TRIGGER stock_movements_match_variant_stock
  AFTER INSERT ON "stock_movements"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_variant_stock_matches_ledger();

-- 4. Expense categories from PRD §4.12, plus the write-off category that
--    DAMAGE_OUT posts to. Seeded here (not only in prisma/seed.ts) so a
--    damage write-off works on a database that was never re-seeded.
INSERT INTO "expense_categories" ("id", "name", "sortOrder", "isActive", "createdAt", "updatedAt") VALUES
  ('expcat_ad_cost',          'Ad cost',                 1,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_product_purchase', 'Product purchase',        2,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_courier',          'Courier',                 3,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_salary',           'Salary',                  4,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_rent',             'Rent',                    5,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_utility',          'Utility',                 6,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_packaging',        'Packaging',               7,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_transport',        'Transport',               8,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_exchange_return',  'Exchange/return cost',    9,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_stock_writeoff',   'Stock damage / write-off', 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_misc',             'Misc',                    11, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
