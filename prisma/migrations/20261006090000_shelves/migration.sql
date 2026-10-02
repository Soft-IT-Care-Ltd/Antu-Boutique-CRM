-- C4b — CORRECTIONS.md item 20A: shelves inside a location.
--
-- A "where is it" layer inside a location. It never touches the stock
-- ledger or accounting. Unassigned = variant_stocks.qty − sum(shelf_stocks)
-- is derived, never stored, so it cannot drift; the database holds the
-- rest (section at the end):
--   * a shelf quantity is never below zero
--   * per (variant, location): sum(shelf_stocks) + open "not on its shelf"
--     units <= GREATEST(variant_stocks.qty, 0) — checked at COMMIT

-- CreateEnum
CREATE TYPE "ShelfMovementKind" AS ENUM ('PUT_AWAY', 'MOVE', 'OUT', 'MISSING', 'FOUND', 'MISS_CLOSED');

-- CreateEnum
CREATE TYPE "ShelfCountStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "usesShelves" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_transfer_lines" ADD COLUMN     "shelfPicks" JSONB;

-- CreateTable
CREATE TABLE "shelves" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCountedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shelves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelf_stocks" (
    "shelfId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shelf_stocks_pkey" PRIMARY KEY ("shelfId","variantId")
);

-- CreateTable
CREATE TABLE "shelf_misses" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "shelfId" TEXT NOT NULL,
    "shelfCountId" TEXT,
    "qty" INTEGER NOT NULL,
    "originalQty" INTEGER NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shelf_misses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelf_movements" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "kind" "ShelfMovementKind" NOT NULL,
    "qty" INTEGER NOT NULL,
    "fromShelfId" TEXT,
    "toShelfId" TEXT,
    "missId" TEXT,
    "stockMovementId" TEXT,
    "shelfCountId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shelf_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelf_counts" (
    "id" TEXT NOT NULL,
    "shelfId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "ShelfCountStatus" NOT NULL DEFAULT 'OPEN',
    "openedAtSeq" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "finishedById" TEXT,
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shelf_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelf_count_lines" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "countedQty" INTEGER NOT NULL DEFAULT 0,
    "shelfQtyAtScan" INTEGER,
    "expectedQty" INTEGER,
    "missingQty" INTEGER,
    "placedQty" INTEGER,
    "unplacedQty" INTEGER,

    CONSTRAINT "shelf_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shelves_locationId_code_key" ON "shelves"("locationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "shelves_id_locationId_key" ON "shelves"("id", "locationId");

-- CreateIndex
CREATE INDEX "shelf_stocks_variantId_locationId_idx" ON "shelf_stocks"("variantId", "locationId");

-- CreateIndex
CREATE INDEX "shelf_misses_locationId_closedAt_idx" ON "shelf_misses"("locationId", "closedAt");

-- CreateIndex
CREATE INDEX "shelf_misses_variantId_locationId_idx" ON "shelf_misses"("variantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "shelf_movements_seq_key" ON "shelf_movements"("seq");

-- CreateIndex
CREATE INDEX "shelf_movements_variantId_locationId_seq_idx" ON "shelf_movements"("variantId", "locationId", "seq");

-- CreateIndex
CREATE INDEX "shelf_movements_fromShelfId_seq_idx" ON "shelf_movements"("fromShelfId", "seq");

-- CreateIndex
CREATE INDEX "shelf_movements_toShelfId_seq_idx" ON "shelf_movements"("toShelfId", "seq");

-- CreateIndex
CREATE INDEX "shelf_counts_shelfId_status_idx" ON "shelf_counts"("shelfId", "status");

-- CreateIndex
CREATE INDEX "shelf_counts_locationId_createdAt_idx" ON "shelf_counts"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "shelf_count_lines_variantId_idx" ON "shelf_count_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "shelf_count_lines_countId_variantId_key" ON "shelf_count_lines"("countId", "variantId");

-- AddForeignKey
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_stocks" ADD CONSTRAINT "shelf_stocks_shelfId_locationId_fkey" FOREIGN KEY ("shelfId", "locationId") REFERENCES "shelves"("id", "locationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_stocks" ADD CONSTRAINT "shelf_stocks_variantId_locationId_fkey" FOREIGN KEY ("variantId", "locationId") REFERENCES "variant_stocks"("variantId", "locationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_misses" ADD CONSTRAINT "shelf_misses_variantId_locationId_fkey" FOREIGN KEY ("variantId", "locationId") REFERENCES "variant_stocks"("variantId", "locationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_misses" ADD CONSTRAINT "shelf_misses_shelfId_locationId_fkey" FOREIGN KEY ("shelfId", "locationId") REFERENCES "shelves"("id", "locationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_misses" ADD CONSTRAINT "shelf_misses_shelfCountId_fkey" FOREIGN KEY ("shelfCountId") REFERENCES "shelf_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_misses" ADD CONSTRAINT "shelf_misses_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_movements" ADD CONSTRAINT "shelf_movements_fromShelfId_fkey" FOREIGN KEY ("fromShelfId") REFERENCES "shelves"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_movements" ADD CONSTRAINT "shelf_movements_toShelfId_fkey" FOREIGN KEY ("toShelfId") REFERENCES "shelves"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_movements" ADD CONSTRAINT "shelf_movements_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_counts" ADD CONSTRAINT "shelf_counts_shelfId_locationId_fkey" FOREIGN KEY ("shelfId", "locationId") REFERENCES "shelves"("id", "locationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_counts" ADD CONSTRAINT "shelf_counts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_counts" ADD CONSTRAINT "shelf_counts_finishedById_fkey" FOREIGN KEY ("finishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_count_lines" ADD CONSTRAINT "shelf_count_lines_countId_fkey" FOREIGN KEY ("countId") REFERENCES "shelf_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelf_count_lines" ADD CONSTRAINT "shelf_count_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written: the shelf rules the database holds ─────────────────────

ALTER TABLE "shelves" ADD CONSTRAINT "shelves_code_chk" CHECK ("code" ~ '^[A-Z0-9]{1,4}(-[A-Z0-9]{1,4}){1,3}$');
ALTER TABLE "shelf_stocks" ADD CONSTRAINT "shelf_stocks_qty_chk" CHECK ("qty" >= 0);
ALTER TABLE "shelf_misses" ADD CONSTRAINT "shelf_misses_qty_chk" CHECK ("qty" >= 0 AND "qty" <= "originalQty" AND "originalQty" > 0);
ALTER TABLE "shelf_misses" ADD CONSTRAINT "shelf_misses_closed_chk" CHECK (("closedAt" IS NULL) = ("qty" > 0));
ALTER TABLE "shelf_movements" ADD CONSTRAINT "shelf_movements_qty_chk" CHECK ("qty" > 0);
ALTER TABLE "shelf_movements" ADD CONSTRAINT "shelf_movements_sides_chk" CHECK (
  CASE "kind"
    WHEN 'PUT_AWAY'    THEN "fromShelfId" IS NULL AND "toShelfId" IS NOT NULL
    WHEN 'MOVE'        THEN "fromShelfId" IS NOT NULL AND "toShelfId" IS NOT NULL AND "fromShelfId" <> "toShelfId"
    WHEN 'OUT'         THEN "fromShelfId" IS NOT NULL AND "toShelfId" IS NULL
    WHEN 'MISSING'     THEN "fromShelfId" IS NOT NULL AND "toShelfId" IS NULL AND "missId" IS NOT NULL
    WHEN 'FOUND'       THEN "fromShelfId" IS NULL AND "toShelfId" IS NOT NULL AND "missId" IS NOT NULL
    WHEN 'MISS_CLOSED' THEN "fromShelfId" IS NULL AND "toShelfId" IS NULL AND "missId" IS NOT NULL
  END
);
ALTER TABLE "shelf_count_lines" ADD CONSTRAINT "shelf_count_lines_counted_chk" CHECK ("countedQty" >= 0);

-- Shelves can never hold more than the location has. Deferred to COMMIT, like
-- the stock = ledger triggers (migration 20261003090000), so a stock row and
-- its shelf rows can be written in either order inside one transaction.
CREATE FUNCTION assert_shelves_within_location_stock() RETURNS trigger AS $$
DECLARE
  v_stock INTEGER;
  v_shelved BIGINT;
  v_missing BIGINT;
BEGIN
  SELECT "qty" INTO v_stock FROM "variant_stocks" WHERE "variantId" = NEW."variantId" AND "locationId" = NEW."locationId";
  IF NOT FOUND THEN
    v_stock := 0;
  END IF;
  SELECT COALESCE(SUM("qty"), 0) INTO v_shelved FROM "shelf_stocks" WHERE "variantId" = NEW."variantId" AND "locationId" = NEW."locationId";
  SELECT COALESCE(SUM("qty"), 0) INTO v_missing FROM "shelf_misses" WHERE "variantId" = NEW."variantId" AND "locationId" = NEW."locationId" AND "closedAt" IS NULL;

  IF v_shelved + v_missing > GREATEST(v_stock, 0) THEN
    RAISE EXCEPTION 'shelves exceed location stock on variant % at location %: shelves = %, not on its shelf = %, location stock = %', NEW."variantId", NEW."locationId", v_shelved, v_missing, v_stock
      USING ERRCODE = 'check_violation',
            HINT = 'Move shelf quantities only through lib/shelves/engine.ts; stock leaving a location takes its units off the shelves in the same transaction.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER shelf_stocks_within_location_stock
  AFTER INSERT OR UPDATE ON "shelf_stocks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_shelves_within_location_stock();

CREATE CONSTRAINT TRIGGER shelf_misses_within_location_stock
  AFTER INSERT OR UPDATE ON "shelf_misses"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_shelves_within_location_stock();

CREATE CONSTRAINT TRIGGER variant_stocks_cover_shelves
  AFTER UPDATE OF "qty" ON "variant_stocks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_shelves_within_location_stock();

-- The packing hub warehouse is divided into shelves; the showroom, the
-- parlour corner and the studio are not (Settings → Locations can change it).
UPDATE "locations" SET "usesShelves" = true WHERE "id" = 'loc_mohammadpur';
