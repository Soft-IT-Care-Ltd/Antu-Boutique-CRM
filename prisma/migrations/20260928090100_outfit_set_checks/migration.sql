-- P3.3 — rules the database holds for outfit sets and packaging.

-- A packaging material has no selling price: it's never sold on its own.
ALTER TABLE "products" ADD CONSTRAINT "products_component_only_price_chk"
  CHECK ("kind" = 'SELLABLE' OR "basePrice" = 0);

ALTER TABLE "outfit_sets" ADD CONSTRAINT "outfit_sets_price_chk" CHECK ("price" >= 0);
ALTER TABLE "outfit_sets" ADD CONSTRAINT "outfit_sets_name_chk" CHECK (NULLIF(btrim("name"), '') IS NOT NULL);
ALTER TABLE "outfit_set_components" ADD CONSTRAINT "outfit_set_components_qty_chk" CHECK ("qty" BETWEEN 1 AND 99);

-- Exactly one owner: a product, a set, or an order-level default.
ALTER TABLE "packaging_components" ADD CONSTRAINT "packaging_components_owner_chk"
  CHECK ((("productId" IS NOT NULL)::int + ("outfitSetId" IS NOT NULL)::int + ("scope" IS NOT NULL)::int) = 1);
ALTER TABLE "packaging_components" ADD CONSTRAINT "packaging_components_qty_chk" CHECK ("qty" BETWEEN 1 AND 99);

ALTER TABLE "order_set_lines" ADD CONSTRAINT "order_set_lines_amounts_chk"
  CHECK ("qty" >= 1 AND "unitPrice" >= 0 AND "lineDiscount" >= 0 AND "lineDiscount" <= "unitPrice" * "qty");

-- The system category packaging used posts to: "Packaging" heading, never
-- picked by hand. One expense per order (expenses.packagingOrderId unique).
INSERT INTO "expense_categories" ("id", "name", "kind", "defaultNature", "isSystem", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES ('expcat_packaging_used', 'Packaging used', 'PACKAGING', 'VARIABLE', true, 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "isSystem" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;
