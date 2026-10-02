-- CreateEnum
CREATE TYPE "FulfilmentStatus" AS ENUM ('READY_TO_PACK', 'NEEDS_TRANSFER', 'WAITING_FOR_STOCK');

-- CreateEnum
CREATE TYPE "FulfilmentActionKind" AS ENUM ('SUBSTITUTE', 'WAIT', 'REMOVE_ITEM', 'CANCEL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'ORDER_STOCK_ARRIVED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORDER_STOCK_LOST';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "atHubQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "backorderQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "incomingQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transferFrom" JSONB,
ADD COLUMN     "transferQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fulfilmentChangedAt" TIMESTAMP(3),
ADD COLUMN     "fulfilmentStatus" "FulfilmentStatus",
ADD COLUMN     "stockExpectedOn" TIMESTAMP(3),
ADD COLUMN     "waitingSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "fulfilment_queue" (
    "id" BIGSERIAL NOT NULL,
    "variantId" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfilment_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfilment_actions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "FulfilmentActionKind" NOT NULL,
    "orderItemId" TEXT,
    "variantId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "substituteVariantId" TEXT,
    "substituteQty" INTEGER,
    "reason" TEXT NOT NULL,
    "expectedOn" TIMESTAMP(3),
    "settlement" TEXT,
    "settlementAmount" DECIMAL(12,2),
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfilment_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fulfilment_actions_orderId_idx" ON "fulfilment_actions"("orderId");

-- CreateIndex
CREATE INDEX "fulfilment_actions_kind_createdAt_idx" ON "fulfilment_actions"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "orders_fulfilmentStatus_idx" ON "orders"("fulfilmentStatus");

-- AddForeignKey
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_substituteVariantId_fkey" FOREIGN KEY ("substituteVariantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- C5 — every change that can move an order's fulfilment queues its variants
-- for lib/fulfilment/settle.ts. In the database, so no stock movement, no
-- reservation, no transfer and no order change can be missed by a code path
-- that forgot to ask. The queue has no unique key: two transactions queueing
-- the same variant never wait on each other.
-- ---------------------------------------------------------------------------

-- A variant's total, reservation or in-transit figure moved.
CREATE FUNCTION "fulfilment_queue_from_variant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "fulfilment_queue" ("variantId") VALUES (NEW."id");
  RETURN NULL;
END $$;
CREATE TRIGGER "product_variants_fulfilment_queue"
  AFTER UPDATE OF "stockQty", "reservedQty", "inTransitQty" ON "product_variants"
  FOR EACH ROW
  WHEN (OLD."stockQty" IS DISTINCT FROM NEW."stockQty" OR OLD."reservedQty" IS DISTINCT FROM NEW."reservedQty" OR OLD."inTransitQty" IS DISTINCT FROM NEW."inTransitQty")
  EXECUTE FUNCTION "fulfilment_queue_from_variant"();

-- A location's figure for a variant moved (a transfer receive moves stock
-- between places without changing the total).
CREATE FUNCTION "fulfilment_queue_from_variant_stock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "fulfilment_queue" ("variantId") VALUES (NEW."variantId");
  RETURN NULL;
END $$;
CREATE TRIGGER "variant_stocks_fulfilment_queue"
  AFTER INSERT OR UPDATE OF "qty" ON "variant_stocks"
  FOR EACH ROW EXECUTE FUNCTION "fulfilment_queue_from_variant_stock"();

-- Transfer lines (a Draft's requested / scanned quantities are promised supply).
CREATE FUNCTION "fulfilment_queue_from_transfer_line"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN INSERT INTO "fulfilment_queue" ("variantId") VALUES (OLD."variantId"); END IF;
  IF TG_OP <> 'DELETE' THEN INSERT INTO "fulfilment_queue" ("variantId") VALUES (NEW."variantId"); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "stock_transfer_lines_fulfilment_queue"
  AFTER INSERT OR DELETE OR UPDATE OF "variantId", "qtyRequested", "qtySent" ON "stock_transfer_lines"
  FOR EACH ROW EXECUTE FUNCTION "fulfilment_queue_from_transfer_line"();

-- A transfer drafted, sent, received or cancelled, or re-pointed.
CREATE FUNCTION "fulfilment_queue_from_transfer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "fulfilment_queue" ("variantId") SELECT "variantId" FROM "stock_transfer_lines" WHERE "transferId" = NEW."id";
  RETURN NULL;
END $$;
CREATE TRIGGER "stock_transfers_fulfilment_queue"
  AFTER UPDATE OF "status", "fromLocationId", "toLocationId" ON "stock_transfers"
  FOR EACH ROW EXECUTE FUNCTION "fulfilment_queue_from_transfer"();

-- Order lines added, removed or changed.
CREATE FUNCTION "fulfilment_queue_from_order_item"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN INSERT INTO "fulfilment_queue" ("variantId") VALUES (OLD."variantId"); END IF;
  IF TG_OP <> 'DELETE' THEN INSERT INTO "fulfilment_queue" ("variantId") VALUES (NEW."variantId"); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "order_items_fulfilment_queue"
  AFTER INSERT OR DELETE OR UPDATE OF "variantId", "qty" ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION "fulfilment_queue_from_order_item"();

-- An order entering or leaving Confirmed (or trashed / restored, or its
-- place in the queue changing): every variant on it.
CREATE FUNCTION "fulfilment_queue_from_order"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "fulfilment_queue" ("variantId") SELECT "variantId" FROM "order_items" WHERE "orderId" = NEW."id";
  RETURN NULL;
END $$;
CREATE TRIGGER "orders_fulfilment_queue"
  AFTER UPDATE OF "status", "deletedAt", "channel", "createdAt" ON "orders"
  FOR EACH ROW
  WHEN ((OLD."status" = 'CONFIRMED' OR NEW."status" = 'CONFIRMED')
    AND (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt" OR OLD."channel" IS DISTINCT FROM NEW."channel" OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"))
  EXECUTE FUNCTION "fulfilment_queue_from_order"();

-- The packing hub moved, or a location was switched on/off or reordered:
-- everything is recomputed ("*").
CREATE FUNCTION "fulfilment_queue_everything"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "fulfilment_queue" ("variantId") VALUES ('*');
  RETURN NULL;
END $$;
CREATE TRIGGER "locations_fulfilment_queue"
  AFTER UPDATE OF "isPackingHub", "isActive", "sortOrder" ON "locations"
  FOR EACH ROW
  WHEN (OLD."isPackingHub" IS DISTINCT FROM NEW."isPackingHub" OR OLD."isActive" IS DISTINCT FROM NEW."isActive" OR OLD."sortOrder" IS DISTINCT FROM NEW."sortOrder")
  EXECUTE FUNCTION "fulfilment_queue_everything"();

-- Every confirmed order gets its first status on the next settle.
INSERT INTO "fulfilment_queue" ("variantId") VALUES ('*');

-- A line's split is never negative. (It sums to qty after each settle; an
-- edit may lower qty first, so that is checked by the tests, not here.)
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fulfilment_split_chk"
  CHECK ("atHubQty" >= 0 AND "incomingQty" >= 0 AND "transferQty" >= 0 AND "backorderQty" >= 0);

-- A fulfilment action's reason is never blank; lost-sale quantities are positive.
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_reason_chk" CHECK (length(btrim("reason")) >= 3);
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_qty_chk" CHECK ("qty" >= 0 AND "value" >= 0);
ALTER TABLE "fulfilment_actions" ADD CONSTRAINT "fulfilment_actions_settlement_chk" CHECK ("settlement" IS NULL OR ("settlement" IN ('STORE_CREDIT', 'REFUND') AND "settlementAmount" > 0));
