import { z } from "zod";

import { MAX_TARGET_VALUE, REWARD_METRIC_UNIT, REWARD_METRIC_VALUES, REWARD_SCOPE_VALUES } from "@/lib/targets/constants";

/** A reward rule, as created or edited (lib/targets/rewards.ts). */
export const ruleSchema = z
  .object({
    name: z.string().trim().min(1, "Name the rule").max(80),
    scope: z.enum(REWARD_SCOPE_VALUES),
    metric: z.enum(REWARD_METRIC_VALUES),
    threshold: z.coerce.number().positive("Enter a threshold above zero").max(MAX_TARGET_VALUE),
    minDeliveredRate: z.coerce.number().int("Whole percent only").min(1).max(100).nullable().optional(),
    rewardAmount: z.coerce.number().positive().max(MAX_TARGET_VALUE).multipleOf(0.01, "At most two decimals").nullable().optional(),
    rewardNote: z.string().trim().max(200).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((r) => Boolean(r.rewardAmount) || Boolean(r.rewardNote), "Give the reward an amount, a note, or both")
  .refine((r) => REWARD_METRIC_UNIT[r.metric] !== "percent" || r.threshold <= 1000, "A percentage threshold goes up to 1000%")
  .refine((r) => REWARD_METRIC_UNIT[r.metric] !== "count" || Number.isInteger(r.threshold), "An order-count threshold is a whole number");
