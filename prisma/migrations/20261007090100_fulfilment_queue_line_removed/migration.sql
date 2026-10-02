-- C5 — a line removed from (or swapped on) a confirmed order changes the
-- order's status even though its other variants' stock didn't move: queue
-- every variant still on the order too, so the next settle recomputes it.
CREATE OR REPLACE FUNCTION "fulfilment_queue_from_order_item"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN INSERT INTO "fulfilment_queue" ("variantId") VALUES (OLD."variantId"); END IF;
  IF TG_OP <> 'DELETE' THEN INSERT INTO "fulfilment_queue" ("variantId") VALUES (NEW."variantId"); END IF;
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO "fulfilment_queue" ("variantId")
    SELECT DISTINCT "variantId" FROM "order_items" WHERE "orderId" = OLD."orderId" AND "variantId" <> OLD."variantId";
  END IF;
  RETURN NULL;
END $$;
