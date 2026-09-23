-- P2.3 — wallets, payment verification, refunds, expenses, daily ad spend.
-- Prisma-generated DDL first; the hand-written data steps follow it. The
-- old free-text `wallet` columns are backfilled into wallet links and only
-- then dropped. A payment whose text matched no wallet keeps it in its note.

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExpenseKind" AS ENUM ('AD_COST', 'PURCHASE', 'COURIER', 'SALARY', 'RENT', 'UTILITY', 'PACKAGING', 'TRANSPORT', 'EXCHANGE_RETURN', 'MISC');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('BKASH', 'NAGAD', 'ROCKET', 'BANK', 'CASH');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('MANUAL_IN', 'MANUAL_OUT', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "AdPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'GOOGLE', 'OTHER');

-- AlterTable
ALTER TABLE "courier_statements" ADD COLUMN     "walletId" TEXT;

-- AlterTable
ALTER TABLE "expense_categories" ADD COLUMN     "defaultNature" "ExpenseNature" NOT NULL DEFAULT 'VARIABLE',
ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "ExpenseKind" NOT NULL DEFAULT 'MISC';

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "adSpendId" TEXT,
ADD COLUMN     "attachmentMime" TEXT,
ADD COLUMN     "attachmentName" TEXT,
ADD COLUMN     "attachmentPath" TEXT,
ADD COLUMN     "walletId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT',
ADD COLUMN     "refundReason" TEXT,
ADD COLUMN     "refundStatus" "RefundStatus",
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT,
ADD COLUMN     "walletId" TEXT;

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WalletType" NOT NULL,
    "accountNo" TEXT,
    "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "openingDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_entries" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL,
    "transferId" TEXT,
    "createdById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_ad_spend" (
    "id" TEXT NOT NULL,
    "spendDate" TIMESTAMP(3) NOT NULL,
    "platform" "AdPlatform" NOT NULL DEFAULT 'FACEBOOK',
    "amount" DECIMAL(12,2) NOT NULL,
    "walletId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_ad_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_name_key" ON "wallets"("name");

-- CreateIndex
CREATE INDEX "wallet_entries_walletId_entryDate_idx" ON "wallet_entries"("walletId", "entryDate");

-- CreateIndex
CREATE INDEX "wallet_entries_transferId_idx" ON "wallet_entries"("transferId");

-- CreateIndex
CREATE INDEX "daily_ad_spend_spendDate_idx" ON "daily_ad_spend"("spendDate");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_adSpendId_key" ON "expenses"("adSpendId");

-- CreateIndex
CREATE INDEX "expenses_walletId_idx" ON "expenses"("walletId");

-- CreateIndex
CREATE INDEX "payments_walletId_idx" ON "payments"("walletId");

-- CreateIndex
CREATE INDEX "payments_verified_idx" ON "payments"("verified");

-- CreateIndex
CREATE INDEX "payments_refundStatus_idx" ON "payments"("refundStatus");

-- CreateIndex
CREATE INDEX "payments_paidAt_idx" ON "payments"("paidAt");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_adSpendId_fkey" FOREIGN KEY ("adSpendId") REFERENCES "daily_ad_spend"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_ad_spend" ADD CONSTRAINT "daily_ad_spend_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_ad_spend" ADD CONSTRAINT "daily_ad_spend_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_statements" ADD CONSTRAINT "courier_statements_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: data + database-level rules
-- ---------------------------------------------------------------------------

-- 1. The wallets PRD §4.10 names. Opening balance 0 dated 1 Jan 2026 (Dhaka)
--    so all history counts; set the real figures before go-live (SETUP.md).
INSERT INTO "wallets" ("id", "name", "type", "openingBalance", "openingDate", "sortOrder", "createdAt", "updatedAt") VALUES
  ('wallet_bkash_personal', 'bKash Personal', 'BKASH',  0, '2025-12-31 18:00:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wallet_bkash_merchant', 'bKash Merchant', 'BKASH',  0, '2025-12-31 18:00:00', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wallet_nagad',          'Nagad',          'NAGAD',  0, '2025-12-31 18:00:00', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wallet_rocket',         'Rocket',         'ROCKET', 0, '2025-12-31 18:00:00', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wallet_bank',           'Bank Account',   'BANK',   0, '2025-12-31 18:00:00', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wallet_showroom_cash',  'Showroom Cash',  'CASH',   0, '2025-12-31 18:00:00', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- 2. Payments: text → wallet link (case/space-insensitive). COURIER_COD never
--    carries a wallet — its money arrives as the statement's net payout.
UPDATE "payments" p SET "walletId" = w."id"
FROM "wallets" w
WHERE p."method" <> 'COURIER_COD' AND p."wallet" IS NOT NULL
  AND lower(btrim(p."wallet")) = lower(w."name");

UPDATE "payments"
SET "note" = concat_ws(' · ', NULLIF("note", ''), 'Wallet (before P2.3): ' || "wallet")
WHERE "method" <> 'COURIER_COD' AND "walletId" IS NULL AND NULLIF(btrim("wallet"), '') IS NOT NULL;

ALTER TABLE "payments" DROP COLUMN "wallet";

-- Existing verified payments: when/by whom isn't known; stamp the time only.
UPDATE "payments" SET "verifiedAt" = "updatedAt" WHERE "verified" = true AND "verifiedAt" IS NULL;

-- 3. Courier statements: text → wallet link; unknown text falls back to the bank.
UPDATE "courier_statements" s SET "walletId" = COALESCE(
  (SELECT w."id" FROM "wallets" w WHERE lower(w."name") = lower(btrim(s."wallet"))),
  'wallet_bank'
);

UPDATE "courier_statements"
SET "note" = concat_ws(' · ', NULLIF("note", ''), 'Wallet (before P2.3): ' || "wallet")
WHERE NULLIF(btrim("wallet"), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "wallets" w WHERE lower(w."name") = lower(btrim("courier_statements"."wallet")));

ALTER TABLE "courier_statements" DROP COLUMN "wallet";

-- 4. Rules the database enforces, whatever the application does.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_sign_chk"
  CHECK (("kind" = 'PAYMENT' AND "amount" > 0) OR ("kind" = 'REFUND' AND "amount" < 0));
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_fields_chk"
  CHECK (("kind" = 'PAYMENT' AND "refundStatus" IS NULL)
      OR ("kind" = 'REFUND' AND "refundStatus" IS NOT NULL AND NULLIF(btrim("refundReason"), '') IS NOT NULL));
ALTER TABLE "payments" ADD CONSTRAINT "payments_courier_cod_no_wallet_chk"
  CHECK ("method" <> 'COURIER_COD' OR "walletId" IS NULL);
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_amount_positive_chk" CHECK ("amount" > 0);
ALTER TABLE "daily_ad_spend" ADD CONSTRAINT "daily_ad_spend_amount_positive_chk" CHECK ("amount" > 0);

-- 5. Expense categories → PRD §4.12 headings. System categories are posted
--    by the app (ad spend, courier statements, condition checks, write-offs)
--    and can't be picked on the expense form, so nothing is entered twice.
UPDATE "expense_categories" SET "kind" = 'AD_COST',         "isSystem" = true  WHERE "id" = 'expcat_ad_cost';
UPDATE "expense_categories" SET "kind" = 'PURCHASE'                            WHERE "id" = 'expcat_product_purchase';
UPDATE "expense_categories" SET "kind" = 'COURIER'                             WHERE "id" = 'expcat_courier';
UPDATE "expense_categories" SET "kind" = 'SALARY',  "defaultNature" = 'FIXED'  WHERE "id" = 'expcat_salary';
UPDATE "expense_categories" SET "kind" = 'RENT',    "defaultNature" = 'FIXED'  WHERE "id" = 'expcat_rent';
UPDATE "expense_categories" SET "kind" = 'UTILITY', "defaultNature" = 'FIXED'  WHERE "id" = 'expcat_utility';
UPDATE "expense_categories" SET "kind" = 'PACKAGING'                           WHERE "id" = 'expcat_packaging';
UPDATE "expense_categories" SET "kind" = 'TRANSPORT'                           WHERE "id" = 'expcat_transport';
UPDATE "expense_categories" SET "kind" = 'EXCHANGE_RETURN'                     WHERE "id" = 'expcat_exchange_return';
UPDATE "expense_categories" SET "kind" = 'MISC',            "isSystem" = true  WHERE "id" = 'expcat_stock_writeoff';
UPDATE "expense_categories" SET "kind" = 'MISC'                                WHERE "id" = 'expcat_misc';

INSERT INTO "expense_categories" ("id", "name", "kind", "isSystem", "sortOrder", "isActive", "createdAt", "updatedAt") VALUES
  ('expcat_courier_return_charge',   'Courier return charge',   'COURIER', true, 12, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_courier_delivery_charge', 'Courier delivery charge', 'COURIER', true, 13, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('expcat_cod_charge',              'COD charge',              'COURIER', true, 14, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET "kind" = EXCLUDED."kind", "isSystem" = true;
