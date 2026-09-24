-- P3.2 — store credit rules the database holds, whatever the app does.

-- A STORE_CREDIT payment moves no money into or out of a wallet: the money
-- is already in the shop. Positive = credit spent on this order; negative =
-- credit issued out of it (or given back after a cancellation).
ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_sign_chk";
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_sign_chk"
  CHECK (("kind" = 'PAYMENT' AND "amount" > 0) OR ("kind" = 'REFUND' AND "amount" < 0)
      OR ("kind" IN ('EXCHANGE_CREDIT', 'STORE_CREDIT') AND "amount" <> 0));
ALTER TABLE "payments" DROP CONSTRAINT "payments_refund_fields_chk";
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_fields_chk"
  CHECK (("kind" IN ('PAYMENT', 'EXCHANGE_CREDIT', 'STORE_CREDIT') AND "refundStatus" IS NULL)
      OR ("kind" = 'REFUND' AND "refundStatus" IS NOT NULL AND NULLIF(btrim("refundReason"), '') IS NOT NULL));
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_credit_chk"
  CHECK ((("kind" = 'STORE_CREDIT') = ("method" = 'STORE_CREDIT'))
     AND ("kind" <> 'STORE_CREDIT'
          OR ("walletId" IS NULL AND "transactionId" IS NULL AND "verified" AND "cashTendered" IS NULL)));

-- The ledger: each type moves the balance one way only; everything but an
-- Admin adjustment goes through an order's STORE_CREDIT payment; an
-- adjustment always says why; only credit coming in can expire.
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_amount_chk"
  CHECK (("type" IN ('ISSUED', 'RESTORED') AND "amount" > 0)
      OR ("type" = 'USED' AND "amount" < 0)
      OR ("type" = 'ADJUSTED' AND "amount" <> 0));
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_source_chk"
  CHECK (("type" = 'ADJUSTED' AND "paymentId" IS NULL AND NULLIF(btrim("reason"), '') IS NOT NULL)
      OR ("type" <> 'ADJUSTED' AND "paymentId" IS NOT NULL AND "orderId" IS NOT NULL));
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_expiry_chk"
  CHECK ("expiresAt" IS NULL OR "amount" > 0);
