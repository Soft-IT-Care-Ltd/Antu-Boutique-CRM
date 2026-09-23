-- The system category every DAMAGE_OUT write-off posts to becomes
-- "Damage / write-off" under its own DAMAGE_WRITE_OFF heading.
INSERT INTO "expense_categories" ("id", "name", "kind", "defaultNature", "isSystem", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES ('expcat_stock_writeoff', 'Damage / write-off', 'DAMAGE_WRITE_OFF', 'VARIABLE', true, 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "isSystem" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;

-- Every existing write-off expense (the ones posted by a stock movement)
-- moves to it, wherever it had been filed.
UPDATE "expenses" SET "categoryId" = 'expcat_stock_writeoff', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "stockMovementId" IS NOT NULL AND "categoryId" <> 'expcat_stock_writeoff';
