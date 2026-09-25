-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('FACEBOOK_AD', 'MESSENGER', 'WHATSAPP', 'INSTAGRAM', 'REFERRAL', 'REPEAT_CUSTOMER', 'SHOWROOM_WALK_IN', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'FOLLOW_UP', 'NEGOTIATING', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "LeadLostReason" AS ENUM ('PRICE', 'SIZE_UNAVAILABLE', 'NO_RESPONSE', 'BOUGHT_ELSEWHERE', 'OTHER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "leadId" TEXT;

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "customerId" TEXT,
    "source" "LeadSource" NOT NULL,
    "campaign" TEXT,
    "interest" TEXT,
    "notes" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "lostReason" "LeadLostReason",
    "lostNote" TEXT,
    "lostAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "teamId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_followups" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "outcome" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_daily_counts" (
    "id" TEXT NOT NULL,
    "countDate" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT,
    "source" "LeadSource" NOT NULL,
    "campaign" TEXT,
    "leadCount" INTEGER NOT NULL,
    "convertedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_daily_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_createdById_idx" ON "leads"("createdById");

-- CreateIndex
CREATE INDEX "leads_teamId_idx" ON "leads"("teamId");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_source_idx" ON "leads"("source");

-- CreateIndex
CREATE INDEX "leads_phone_idx" ON "leads"("phone");

-- CreateIndex
CREATE INDEX "leads_customerId_idx" ON "leads"("customerId");

-- CreateIndex
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");

-- CreateIndex
CREATE INDEX "leads_deletedAt_idx" ON "leads"("deletedAt");

-- CreateIndex
CREATE INDEX "lead_followups_leadId_idx" ON "lead_followups"("leadId");

-- CreateIndex
CREATE INDEX "lead_followups_dueAt_completedAt_idx" ON "lead_followups"("dueAt", "completedAt");

-- CreateIndex
CREATE INDEX "lead_daily_counts_userId_countDate_idx" ON "lead_daily_counts"("userId", "countDate");

-- CreateIndex
CREATE INDEX "lead_daily_counts_teamId_idx" ON "lead_daily_counts"("teamId");

-- CreateIndex
CREATE INDEX "lead_daily_counts_countDate_idx" ON "lead_daily_counts"("countDate");

-- CreateIndex
CREATE UNIQUE INDEX "orders_leadId_key" ON "orders"("leadId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_daily_counts" ADD CONSTRAINT "lead_daily_counts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_daily_counts" ADD CONSTRAINT "lead_daily_counts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_daily_counts" ADD CONSTRAINT "lead_daily_counts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

