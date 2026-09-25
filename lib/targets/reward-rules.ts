import type { RewardMetricValue, RewardScopeValue } from "@/lib/targets/constants";
import type { Stats } from "@/lib/targets/stats";

// PRD §4.13 "threshold → reward, auto-evaluated at month end". Pure, so the
// rules themselves are unit-tested. Client- and server-safe.
//
// - A rule applies to each person (INDIVIDUAL) or each team (TEAM).
// - Rules with the same scope and measure are tiers: only the highest
//   threshold reached pays (80% → ৳1,000 and 100% → ৳3,000 pays ৳3,000 at
//   105%, not ৳4,000). Rules on different measures add up.
// - A rule with a delivered-rate floor pays only if at least that share of
//   the month's finished orders (delivered + returned) was delivered — so
//   orders that come back can't buy a reward. No finished order yet means
//   the floor isn't met.
// - A "% of target" rule needs that target; without one it can't be met.

export type RuleInput = {
  id: string;
  name: string;
  scope: RewardScopeValue;
  metric: RewardMetricValue;
  /** Taka for money measures, a percent for % measures, a count for orders. */
  threshold: number;
  minDeliveredRate: number | null;
};

export type SubjectInput = {
  scope: RewardScopeValue;
  id: string;
  target: { orderCount: number | null; orderValuePaisa: number | null } | null;
  stats: Stats;
};

export type EarnedReward = { ruleId: string; subjectId: string; scope: RewardScopeValue; achieved: number };

/** The subject's value for a measure, in the rule's unit (percent to 2 dp); null when it can't be measured. */
export function measure(metric: RewardMetricValue, subject: SubjectInput): number | null {
  const s = subject.stats;
  switch (metric) {
    case "VALUE_TARGET_PERCENT": {
      const goal = subject.target?.orderValuePaisa;
      return goal ? Math.floor((s.salesPaisa * 10_000) / goal) / 100 : null;
    }
    case "COUNT_TARGET_PERCENT": {
      const goal = subject.target?.orderCount;
      return goal ? Math.floor((s.orderCount * 10_000) / goal) / 100 : null;
    }
    case "SALES_VALUE":
      return s.salesPaisa / 100;
    case "DELIVERED_VALUE":
      return s.deliveredPaisa / 100;
    case "ORDER_COUNT":
      return s.orderCount;
  }
}

/** Integer arithmetic: delivered ÷ (delivered + returned) ≥ floor%. */
export function meetsQualityFloor(stats: Stats, minDeliveredRate: number | null): boolean {
  if (minDeliveredRate === null) return true;
  const finished = stats.delivered + stats.returned;
  if (finished === 0) return false;
  return stats.delivered * 100 >= minDeliveredRate * finished;
}

function reaches(metric: RewardMetricValue, value: number, threshold: number): boolean {
  // Money compares in whole paisa so ৳1,00,000.00 ≥ ৳1,00,000 never trips on a float.
  if (metric === "SALES_VALUE" || metric === "DELIVERED_VALUE") return Math.round(value * 100) >= Math.round(threshold * 100);
  return value >= threshold;
}

export function evaluateRewards(rules: RuleInput[], subjects: SubjectInput[]): EarnedReward[] {
  const earned: EarnedReward[] = [];
  for (const subject of subjects) {
    const best = new Map<RewardMetricValue, { rule: RuleInput; achieved: number }>();
    for (const rule of rules) {
      if (rule.scope !== subject.scope) continue;
      const value = measure(rule.metric, subject);
      if (value === null || !reaches(rule.metric, value, rule.threshold)) continue;
      if (!meetsQualityFloor(subject.stats, rule.minDeliveredRate)) continue;
      const current = best.get(rule.metric);
      if (!current || rule.threshold > current.rule.threshold) best.set(rule.metric, { rule, achieved: value });
    }
    for (const { rule, achieved } of best.values()) earned.push({ ruleId: rule.id, subjectId: subject.id, scope: subject.scope, achieved });
  }
  return earned;
}
