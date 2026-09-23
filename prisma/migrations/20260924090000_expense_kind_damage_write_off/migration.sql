-- Stock write-offs get their own P&L heading instead of Misc. The value is
-- added on its own: Postgres can't use a new enum value in the transaction
-- that adds it, so the category move is the next migration.
ALTER TYPE "ExpenseKind" ADD VALUE 'DAMAGE_WRITE_OFF' BEFORE 'MISC';
