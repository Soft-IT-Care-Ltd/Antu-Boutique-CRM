-- CLAUDE.md rule 4: a TrxID is globally unique however it was typed. The
-- app stores it trimmed and upper-cased (lib/orders/payment-validation.ts);
-- this CHECK holds every row to that form, so the existing unique index
-- "payments_transactionId_key" is in effect case- and space-insensitive:
-- "8n7a6b5c" can't sit beside "8N7A6B5C". Blank is stored as NULL.
UPDATE "payments" SET "transactionId" = NULLIF(upper(btrim("transactionId")), '')
 WHERE "transactionId" IS NOT NULL AND "transactionId" IS DISTINCT FROM NULLIF(upper(btrim("transactionId")), '');

ALTER TABLE "payments" ADD CONSTRAINT "payments_transaction_id_normalized_chk"
  CHECK ("transactionId" IS NULL OR ("transactionId" = upper(btrim("transactionId")) AND "transactionId" <> ''));
