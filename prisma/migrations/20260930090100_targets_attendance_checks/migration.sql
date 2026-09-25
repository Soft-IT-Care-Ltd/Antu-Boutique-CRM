-- P4.2 — rules the database holds for targets, rewards, attendance and leave.

-- A target is for one Dhaka calendar month, one person or one team, and
-- sets a count, a value or both — each above zero.
ALTER TABLE "targets" ADD CONSTRAINT "targets_month_chk" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "targets" ADD CONSTRAINT "targets_subject_chk" CHECK (("userId" IS NULL) <> ("teamId" IS NULL));
ALTER TABLE "targets" ADD CONSTRAINT "targets_goal_chk"
  CHECK (("orderCount" IS NOT NULL OR "orderValue" IS NOT NULL)
    AND ("orderCount" IS NULL OR "orderCount" > 0)
    AND ("orderValue" IS NULL OR "orderValue" > 0));

-- A rule names itself, measures past zero, and rewards with an amount, a
-- note or both.
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_name_chk" CHECK (NULLIF(btrim("name"), '') IS NOT NULL);
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_threshold_chk" CHECK ("threshold" > 0);
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_quality_chk" CHECK ("minDeliveredRate" IS NULL OR "minDeliveredRate" BETWEEN 1 AND 100);
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_reward_chk"
  CHECK (("rewardAmount" IS NULL OR "rewardAmount" > 0)
    AND ("rewardAmount" IS NOT NULL OR NULLIF(btrim("rewardNote"), '') IS NOT NULL));

ALTER TABLE "reward_evaluations" ADD CONSTRAINT "reward_evaluations_month_chk" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "reward_awards" ADD CONSTRAINT "reward_awards_subject_chk" CHECK (("userId" IS NULL) <> ("teamId" IS NULL));

-- Check-out never before check-in; a corrected day says why.
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_times_chk" CHECK ("checkOutAt" IS NULL OR "checkOutAt" >= "checkInAt");
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_late_chk" CHECK ("lateMinutes" >= 0);
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_correction_chk"
  CHECK (("correctedAt" IS NULL) = ("correctedById" IS NULL)
    AND ("correctedAt" IS NULL OR NULLIF(btrim("correctionReason"), '') IS NOT NULL));

-- Leave runs forward, gives a reason, and a decided request says who and when.
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_dates_chk" CHECK ("toDate" >= "fromDate");
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reason_chk" CHECK (NULLIF(btrim("reason"), '') IS NOT NULL);
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_chk"
  CHECK (CASE "status"
    WHEN 'PENDING' THEN "decidedAt" IS NULL AND "cancelledAt" IS NULL
    WHEN 'CANCELLED' THEN "cancelledAt" IS NOT NULL
    ELSE "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "cancelledAt" IS NULL
  END);
