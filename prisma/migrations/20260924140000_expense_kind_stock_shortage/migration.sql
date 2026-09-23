-- Stock-count shortfalls get their own P&L heading, apart from damage. Added
-- on its own: Postgres can't use a new enum value in the transaction that
-- adds it, so the category and backfill are the next migration.
ALTER TYPE "ExpenseKind" ADD VALUE 'STOCK_SHORTAGE' BEFORE 'MISC';
