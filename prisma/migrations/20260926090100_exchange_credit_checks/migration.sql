-- P3.2 — the exchange credit (PRD §4.11). Returned items' value moves from
-- the original order to its replacement as a pair of EXCHANGE_CREDIT rows:
-- negative on the original, positive on the replacement. No money moves, so
-- there's no wallet or TrxID, nothing to verify, and always a return case.
-- Split from 20260926090000 because Postgres can't use a new enum value in
-- the transaction that added it.
ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_sign_chk";
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_sign_chk"
  CHECK (("kind" = 'PAYMENT' AND "amount" > 0) OR ("kind" = 'REFUND' AND "amount" < 0) OR ("kind" = 'EXCHANGE_CREDIT' AND "amount" <> 0));
ALTER TABLE "payments" DROP CONSTRAINT "payments_refund_fields_chk";
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_fields_chk"
  CHECK (("kind" IN ('PAYMENT', 'EXCHANGE_CREDIT') AND "refundStatus" IS NULL)
      OR ("kind" = 'REFUND' AND "refundStatus" IS NOT NULL AND NULLIF(btrim("refundReason"), '') IS NOT NULL));
ALTER TABLE "payments" ADD CONSTRAINT "payments_exchange_credit_chk"
  CHECK ((("kind" = 'EXCHANGE_CREDIT') = ("method" = 'EXCHANGE_CREDIT'))
     AND ("kind" <> 'EXCHANGE_CREDIT'
          OR ("walletId" IS NULL AND "transactionId" IS NULL AND "returnCaseId" IS NOT NULL AND "verified" AND "cashTendered" IS NULL)));

-- The system category an online exchange's company-borne courier charge
-- posts to: the "Exchange / return cost" heading, never picked by hand. The
-- courier statement's delivery-charge expense leaves that parcel out, so the
-- charge reaches P&L exactly once (PRD §4.12).
INSERT INTO "expense_categories" ("id", "name", "kind", "defaultNature", "isSystem", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES ('expcat_exchange_courier', 'Exchange courier charge', 'EXCHANGE_RETURN', 'VARIABLE', true, 9, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "isSystem" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;
