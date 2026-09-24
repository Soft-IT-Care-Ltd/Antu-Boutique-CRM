-- The system category a cash drawer's day-end difference posts to — its own
-- CASH_OVER_SHORT heading, never Misc, so the owner sees cash losses apart
-- from stock losses. Split from 20260925090000 because Postgres can't use a
-- new enum value in the transaction that added it.
INSERT INTO "expense_categories" ("id", "name", "kind", "defaultNature", "isSystem", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES ('expcat_cash_over_short', 'Cash over/short', 'CASH_OVER_SHORT', 'VARIABLE', true, 11, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "isSystem" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;

-- A cash drawer's difference may be a credit (cash over), like a stock
-- adjustment's. Everything else stays positive; a zero expense is never written.
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_amount_sign_chk";
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_sign_chk"
  CHECK ("amount" > 0 OR (("stockMovementId" IS NOT NULL OR "cashDrawerId" IS NOT NULL) AND "amount" <> 0));
