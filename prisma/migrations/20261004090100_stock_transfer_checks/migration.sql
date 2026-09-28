-- C4 — the rules behind stock in transit (CORRECTIONS.md item 3), checked
-- by the database at COMMIT like every other stock invariant.

-- 1. Only transfer rows may be in transit (NULL location), and a write-off
--    of missing-in-transit stock is always a transit row.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_transit_chk" CHECK (
  ("locationId" IS NOT NULL OR "type" IN ('TRANSFER_SEND', 'TRANSFER_RECEIVE', 'TRANSIT_WRITE_OFF'))
  AND ("type" <> 'TRANSIT_WRITE_OFF' OR "locationId" IS NULL)
);

ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_in_transit_chk" CHECK ("inTransitQty" >= 0);

-- 2. Per location (existing trigger): an in-transit row belongs to no
--    location, so it is skipped there…
CREATE OR REPLACE FUNCTION assert_location_stock_matches_ledger() RETURNS trigger AS $$
DECLARE
  v_stock INTEGER;
  v_ledger BIGINT;
BEGIN
  IF NEW."locationId" IS NULL THEN
    RETURN NULL;
  END IF;

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

-- 3. …and checked against inTransitQty instead: in transit = the sum of the
--    variant's NULL-location rows.
CREATE FUNCTION assert_in_transit_matches_ledger() RETURNS trigger AS $$
DECLARE
  v_id TEXT;
  v_transit INTEGER;
  v_ledger BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'stock_movements' THEN
    v_id := NEW."variantId";
  ELSE
    v_id := NEW."id";
  END IF;

  SELECT "inTransitQty" INTO v_transit FROM "product_variants" WHERE "id" = v_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("qty"), 0) INTO v_ledger FROM "stock_movements" WHERE "variantId" = v_id AND "locationId" IS NULL;

  IF v_transit <> v_ledger THEN
    RAISE EXCEPTION 'in-transit/ledger divergence on variant %: inTransitQty = %, sum(in-transit stock_movements.qty) = %', v_id, v_transit, v_ledger
      USING ERRCODE = 'check_violation',
            HINT = 'Change stock only through recordStockMovement (lib/inventory/ledger.ts).';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER product_variants_in_transit_matches_ledger
  AFTER UPDATE OF "inTransitQty" ON "product_variants"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_in_transit_matches_ledger();

CREATE CONSTRAINT TRIGGER stock_movements_match_in_transit
  AFTER INSERT ON "stock_movements"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."locationId" IS NULL)
  EXECUTE FUNCTION assert_in_transit_matches_ledger();

-- 4. Transfers.
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_locations_chk" CHECK ("fromLocationId" <> "toLocationId");
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_cancel_chk" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sent_chk" CHECK (("status" IN ('DRAFT', 'CANCELLED')) = ("sentAt" IS NULL));
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_chk" CHECK (("status" IN ('RECEIVED', 'RECEIVED_WITH_DIFFERENCE')) = ("receivedAt" IS NOT NULL));

ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_qty_chk" CHECK (
  "qtyRequested" >= 0 AND "qtySent" >= 0 AND "qtyScannedIn" >= 0 AND "qtyReceived" >= 0 AND "qtyFound" >= 0 AND "qtyWrittenOff" >= 0
  AND "qtyScannedIn" <= "qtySent"
  AND "qtyReceived" + "qtyFound" + "qtyWrittenOff" <= "qtySent"
);

-- 5. Stock counts.
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_qty_chk" CHECK ("countedQty" >= 0);
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_posted_chk" CHECK (("status" = 'POSTED') = ("postedAt" IS NOT NULL));
