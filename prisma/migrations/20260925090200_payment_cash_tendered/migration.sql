-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "cashTendered" DECIMAL(12,2);


-- Only cash can be over-tendered, and never below what it paid.
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_tendered_chk"
  CHECK ("cashTendered" IS NULL OR ("method" = 'CASH' AND "cashTendered" >= "amount"));

-- Walk-in cash payments recorded before this column noted the cash handed
-- over as "Tendered ৳ 1,500, change ৳ 100": carry that figure across.
UPDATE "payments" p
   SET "cashTendered" = t."tendered"
  FROM (
    SELECT "id", replace(substring("note" from 'Tendered ৳ ?([0-9][0-9,]*(\.[0-9]+)?)'), ',', '')::numeric AS "tendered"
      FROM "payments"
     WHERE "method" = 'CASH' AND "note" LIKE 'Tendered ৳%'
  ) t
 WHERE p."id" = t."id" AND t."tendered" >= p."amount";
