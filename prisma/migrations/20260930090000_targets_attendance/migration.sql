-- P4.2 — targets, reward rules and awards (PRD §4.13); attendance and leave (PRD §4.14).
-- CreateEnum
CREATE TYPE "RewardScope" AS ENUM ('INDIVIDUAL', 'TEAM');

-- CreateEnum
CREATE TYPE "RewardMetric" AS ENUM ('VALUE_TARGET_PERCENT', 'COUNT_TARGET_PERCENT', 'SALES_VALUE', 'DELIVERED_VALUE', 'ORDER_COUNT');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('CASUAL', 'SICK', 'ANNUAL', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "orderCount" INTEGER,
    "orderValue" DECIMAL(12,2),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "RewardScope" NOT NULL,
    "metric" "RewardMetric" NOT NULL,
    "threshold" DECIMAL(12,2) NOT NULL,
    "minDeliveredRate" INTEGER,
    "rewardAmount" DECIMAL(12,2),
    "rewardNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_evaluations" (
    "month" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedById" TEXT,

    CONSTRAINT "reward_evaluations_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "reward_awards" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleName" TEXT NOT NULL,
    "scope" "RewardScope" NOT NULL,
    "metric" "RewardMetric" NOT NULL,
    "threshold" DECIMAL(12,2) NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "achieved" DECIMAL(14,2) NOT NULL,
    "salesValue" DECIMAL(14,2) NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "deliveredRate" DECIMAL(5,2),
    "rewardAmount" DECIMAL(12,2),
    "rewardNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "status" "AttendanceStatus" NOT NULL,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "checkInIp" TEXT,
    "checkOutIp" TEXT,
    "correctedById" TEXT,
    "correctedAt" TIMESTAMP(3),
    "correctionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LeaveType" NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "targets_teamId_idx" ON "targets"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "targets_month_userId_key" ON "targets"("month", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "targets_month_teamId_key" ON "targets"("month", "teamId");

-- CreateIndex
CREATE INDEX "reward_awards_month_idx" ON "reward_awards"("month");

-- CreateIndex
CREATE INDEX "reward_awards_userId_idx" ON "reward_awards"("userId");

-- CreateIndex
CREATE INDEX "reward_awards_teamId_idx" ON "reward_awards"("teamId");

-- CreateIndex
CREATE INDEX "attendance_workDate_idx" ON "attendance"("workDate");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_userId_workDate_key" ON "attendance"("userId", "workDate");

-- CreateIndex
CREATE INDEX "leave_requests_userId_fromDate_idx" ON "leave_requests"("userId", "fromDate");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_evaluations" ADD CONSTRAINT "reward_evaluations_evaluatedById_fkey" FOREIGN KEY ("evaluatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_month_fkey" FOREIGN KEY ("month") REFERENCES "reward_evaluations"("month") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "reward_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_correctedById_fkey" FOREIGN KEY ("correctedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

