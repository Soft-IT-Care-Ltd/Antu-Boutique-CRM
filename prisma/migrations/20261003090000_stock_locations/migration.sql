-- C3 — CORRECTIONS.md items 2, 4, 11: stock is held per (variant, location).
--
-- product_variants."stockQty" stays as the TOTAL across locations; the new
-- variant_stocks table holds each location's share. Every ledger row now
-- carries its location. Invariants (all enforced here, at COMMIT):
--   * per variant:            stockQty            = sum(stock_movements.qty)            (existing trigger)
--   * per variant + location: variant_stocks.qty  = sum(that location's rows)          (new trigger)
-- so the total is always the sum of the locations.

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('WAREHOUSE', 'SHOP', 'SALES_CORNER', 'STUDIO');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'NEGATIVE_STOCK';

-- 1. Locations -------------------------------------------------------------

CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "address" TEXT,
    "isPackingHub" BOOLEAN NOT NULL DEFAULT false,
    "hasPos" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id"),
    -- The packing hub can't be switched off (move the hub first).
    CONSTRAINT "locations_hub_active_chk" CHECK (NOT "isPackingHub" OR "isActive"),
    CONSTRAINT "locations_name_chk" CHECK (length(btrim("name")) > 0)
);

CREATE UNIQUE INDEX "locations_name_key" ON "locations"("name");
-- At most one packing hub; the app never leaves the shop without one.
CREATE UNIQUE INDEX "locations_one_packing_hub" ON "locations" ("isPackingHub") WHERE "isPackingHub";

-- The owner's starting locations (CORRECTIONS.md item 2). Fixed ids so the
-- seed, the base seed and the code can name them.
INSERT INTO "locations" ("id", "name", "type", "isPackingHub", "hasPos", "sortOrder", "updatedAt") VALUES
  ('loc_mohammadpur', 'Mohammadpur Warehouse', 'WAREHOUSE',    true,  false, 1, CURRENT_TIMESTAMP),
  ('loc_shyamoli',    'Shyamoli Showroom',     'SHOP',         false, true,  2, CURRENT_TIMESTAMP),
  ('loc_parlour',     'Parlour Sales Corner',  'SALES_CORNER', false, false, 3, CURRENT_TIMESTAMP),
  ('loc_studio',      'Studio',                'STUDIO',       false, false, 4, CURRENT_TIMESTAMP);

-- 2. Location managers ------------------------------------------------------

CREATE TABLE "user_locations" (
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_locations_pkey" PRIMARY KEY ("userId","locationId")
);
CREATE INDEX "user_locations_locationId_idx" ON "user_locations"("locationId");
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Per-location stock -----------------------------------------------------

CREATE TABLE "variant_stocks" (
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_stocks_pkey" PRIMARY KEY ("variantId","locationId")
);
CREATE INDEX "variant_stocks_locationId_idx" ON "variant_stocks"("locationId");
ALTER TABLE "variant_stocks" ADD CONSTRAINT "variant_stocks_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_stocks" ADD CONSTRAINT "variant_stocks_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Every ledger row gets a location --------------------------------------
--
-- Before C3 the shop had one stock pool. Everything already in the ledger
-- is booked to Mohammadpur Warehouse (the packing hub), so each existing
-- variant's stock lands there and the per-location invariant holds from
-- the first commit. The append-only trigger is lifted for this one
-- statement only — the rows' quantities, costs and references are
-- untouched; only the new columns are filled.

ALTER TABLE "stock_movements" ADD COLUMN "locationId" TEXT, ADD COLUMN "locationStockAfter" INTEGER;

ALTER TABLE "stock_movements" DISABLE TRIGGER "stock_movements_no_update_delete";
UPDATE "stock_movements" SET "locationId" = 'loc_mohammadpur', "locationStockAfter" = "stockAfter";
ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_no_update_delete";

ALTER TABLE "stock_movements" ALTER COLUMN "locationId" SET NOT NULL, ALTER COLUMN "locationStockAfter" SET NOT NULL;
CREATE INDEX "stock_movements_locationId_variantId_idx" ON "stock_movements"("locationId", "variantId");
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "variant_stocks" ("variantId", "locationId", "qty", "updatedAt")
SELECT "variantId", "locationId", SUM("qty"), CURRENT_TIMESTAMP
FROM "stock_movements"
GROUP BY "variantId", "locationId";

-- 5. Purchases receive into a location (CORRECTIONS.md item 4) -------------

ALTER TABLE "purchase_items" ADD COLUMN "locationId" TEXT;
UPDATE "purchase_items" SET "locationId" = 'loc_mohammadpur';
ALTER TABLE "purchase_items" ALTER COLUMN "locationId" SET NOT NULL;
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. The per-location invariant, checked at COMMIT --------------------------
--
-- Same shape as assert_variant_stock_matches_ledger (migration
-- 20260923081635): deferred, so the stock row and its ledger row can be
-- written in either order inside one transaction, but never one alone.

CREATE FUNCTION assert_location_stock_matches_ledger() RETURNS trigger AS $$
DECLARE
  v_stock INTEGER;
  v_ledger BIGINT;
BEGIN
  SELECT "qty" INTO v_stock FROM "variant_stocks" WHERE "variantId" = NEW."variantId" AND "locationId" = NEW."locationId";
  IF NOT FOUND THEN
    v_stock := 0;
  END IF;

  SELECT COALESCE(SUM("qty"), 0) INTO v_ledger FROM "stock_movements" WHERE "variantId" = NEW."variantId" AND "locationId" = NEW."locationId";

  IF v_stock <> v_ledger THEN
    RAISE EXCEPTION 'stock/ledger divergence on variant % at location %: variant_stocks.qty = %, sum(stock_movements.qty) = %', NEW."variantId", NEW."locationId", v_stock, v_ledger
      USING ERRCODE = 'check_violation',
            HINT = 'Change stock only through recordStockMovement (lib/inventory/ledger.ts).';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER variant_stocks_match_ledger
  AFTER INSERT OR UPDATE OF "qty" ON "variant_stocks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_location_stock_matches_ledger();

CREATE CONSTRAINT TRIGGER stock_movements_match_location_stock
  AFTER INSERT ON "stock_movements"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_location_stock_matches_ledger();

-- A location's stock row is never deleted or re-pointed: its ledger rows
-- would be left without the balance they add up to.
CREATE FUNCTION variant_stocks_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'variant_stocks rows are never deleted or moved: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER variant_stocks_no_delete
  BEFORE DELETE ON "variant_stocks"
  FOR EACH ROW EXECUTE FUNCTION variant_stocks_reject_change();

CREATE TRIGGER variant_stocks_no_repoint
  BEFORE UPDATE OF "variantId", "locationId" ON "variant_stocks"
  FOR EACH ROW EXECUTE FUNCTION variant_stocks_reject_change();

CREATE TRIGGER variant_stocks_no_truncate
  BEFORE TRUNCATE ON "variant_stocks"
  FOR EACH STATEMENT EXECUTE FUNCTION variant_stocks_reject_change();
