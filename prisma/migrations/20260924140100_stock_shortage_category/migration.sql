-- The system category every manual stock adjustment posts to, at cost.
INSERT INTO "expense_categories" ("id", "name", "kind", "defaultNature", "isSystem", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES ('expcat_stock_shortage', 'Stock shortage', 'STOCK_SHORTAGE', 'VARIABLE', true, 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "isSystem" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;

-- Backfill: every manual adjustment already in the ledger posts its expense
-- now — a shortfall (qty < 0) as a cost, stock found (qty > 0) as a credit —
-- valued at the cost the movement was recorded at. Opening-balance rows are
-- not adjustments and are left alone.
INSERT INTO "expenses" ("id", "expenseDate", "categoryId", "nature", "amount", "note", "stockMovementId", "createdById", "createdAt", "updatedAt")
SELECT 'expshort_' || m."id", m."createdAt", 'expcat_stock_shortage', 'VARIABLE',
       ROUND(-m."qty" * m."unitCostSnapshot", 2),
       CASE WHEN m."qty" < 0 THEN 'Stock shortage: ' || (-m."qty") ELSE 'Stock found: ' || m."qty" END
         || ' × ' || v."sku" || COALESCE(' — ' || m."note", ''),
       m."id", m."actorId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "stock_movements" m
  JOIN "product_variants" v ON v."id" = m."variantId"
 WHERE m."type" = 'ADJUSTMENT' AND m."referenceType" = 'ADJUSTMENT'
   AND ROUND(m."qty" * m."unitCostSnapshot", 2) <> 0
   AND NOT EXISTS (SELECT 1 FROM "expenses" e WHERE e."stockMovementId" = m."id");

-- Only a stock-posted expense may be a credit; everything typed in or posted
-- from money that moved is positive. A zero expense is never written.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_sign_chk"
  CHECK ("amount" > 0 OR ("stockMovementId" IS NOT NULL AND "amount" <> 0));
