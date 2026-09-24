-- P3.2 — what approving a return/exchange left owed to the customer on the
-- original order. When the case settles as store credit, the credit issued
-- at completion is capped at this (lib/returns/case-completion.ts).
ALTER TABLE "return_cases" ADD COLUMN "owedAmount" DECIMAL(12,2);
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_owed_amount_chk" CHECK ("owedAmount" IS NULL OR "owedAmount" >= 0);
