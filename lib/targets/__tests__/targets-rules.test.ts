import { describe, expect, it } from "vitest";

import { daysLeftInMonth, dhakaDayStart, dhakaMonth, monthRange, shiftMonth } from "@/lib/targets/month";
import { evaluateRewards, meetsQualityFloor, type RuleInput, type SubjectInput } from "@/lib/targets/reward-rules";
import { EMPTY_STATS, perDayNeeded, statsFromBuckets, type Stats } from "@/lib/targets/stats";

describe("Dhaka months", () => {
  it("rolls over at Dhaka midnight, not UTC midnight", () => {
    // 30 Sept 18:30 UTC is already 1 Oct 00:30 in Dhaka.
    expect(dhakaMonth(new Date("2026-09-30T18:30:00Z"))).toBe("2026-10");
    expect(dhakaMonth(new Date("2026-09-30T17:59:00Z"))).toBe("2026-09");
  });

  it("covers the month as [Dhaka 1st 00:00, next 1st 00:00)", () => {
    const { from, to } = monthRange("2026-09");
    expect(from.toISOString()).toBe("2026-08-31T18:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-30T18:00:00.000Z");
    expect(dhakaDayStart("2026-09-25").toISOString()).toBe("2026-09-24T18:00:00.000Z");
  });

  it("shifts across years", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("counts the days left to sell, today included", () => {
    const now = new Date("2026-09-25T06:00:00Z"); // 25 Sept, noon in Dhaka
    expect(daysLeftInMonth("2026-09", now)).toBe(6);
    expect(daysLeftInMonth("2026-08", now)).toBe(0);
    expect(daysLeftInMonth("2026-10", now)).toBe(31);
  });
});

describe("month stats", () => {
  it("leaves returned orders out of value and count but counts them for quality", () => {
    const s = statsFromBuckets([
      { status: "DELIVERED", totalPaisa: 500_000, count: 3 },
      { status: "COMPLETED", totalPaisa: 200_000, count: 1 },
      { status: "RETURNED", totalPaisa: 300_000, count: 2 },
      { status: "IN_TRANSIT", totalPaisa: 100_000, count: 1 },
    ]);
    expect(s.salesPaisa).toBe(800_000);
    expect(s.orderCount).toBe(5);
    expect(s.deliveredPaisa).toBe(700_000);
    expect(s.delivered).toBe(4);
    expect(s.returned).toBe(2);
    expect(s.inProgress).toBe(1);
    expect(s.deliveredRate).toBeCloseTo(4 / 6);
  });

  it("has no delivered rate until an order has an outcome", () => {
    expect(statsFromBuckets([{ status: "CONFIRMED", totalPaisa: 1, count: 1 }]).deliveredRate).toBeNull();
  });

  it("works out what's needed per day", () => {
    expect(perDayNeeded(142_000, 200_000, 6)).toBe(9_667);
    expect(perDayNeeded(250_000, 200_000, 6)).toBe(0);
    expect(perDayNeeded(1, 200_000, 0)).toBeNull();
    expect(perDayNeeded(1, null, 5)).toBeNull();
  });
});

const stats = (over: Partial<Stats>): Stats => ({ ...EMPTY_STATS, ...over });
const rule = (over: Partial<RuleInput> & Pick<RuleInput, "id" | "metric" | "threshold">): RuleInput => ({ name: over.id, scope: "INDIVIDUAL", minDeliveredRate: null, ...over });

describe("reward rules", () => {
  const person = (s: Partial<Stats>, target: SubjectInput["target"] = { orderCount: 40, orderValuePaisa: 20_000_000 }): SubjectInput => ({
    scope: "INDIVIDUAL",
    id: "u1",
    target,
    stats: stats(s),
  });

  it("pays only the highest tier reached on a measure", () => {
    const rules = [rule({ id: "t80", metric: "VALUE_TARGET_PERCENT", threshold: 80 }), rule({ id: "t100", metric: "VALUE_TARGET_PERCENT", threshold: 100 })];
    const earned = evaluateRewards(rules, [person({ salesPaisa: 21_000_000 })]);
    expect(earned.map((e) => e.ruleId)).toEqual(["t100"]);
    expect(earned[0].achieved).toBe(105);
  });

  it("adds up rules on different measures", () => {
    const rules = [rule({ id: "pct", metric: "VALUE_TARGET_PERCENT", threshold: 80 }), rule({ id: "cnt", metric: "ORDER_COUNT", threshold: 30 })];
    const earned = evaluateRewards(rules, [person({ salesPaisa: 17_000_000, orderCount: 31 })]);
    expect(earned.map((e) => e.ruleId).sort()).toEqual(["cnt", "pct"]);
  });

  it("can't meet a % rule without that target", () => {
    const earned = evaluateRewards([rule({ id: "pct", metric: "COUNT_TARGET_PERCENT", threshold: 50 })], [person({ orderCount: 100 }, { orderCount: null, orderValuePaisa: 1 })]);
    expect(earned).toEqual([]);
  });

  it("compares money in whole paisa", () => {
    const earned = evaluateRewards([rule({ id: "v", metric: "SALES_VALUE", threshold: 100_000 })], [person({ salesPaisa: 10_000_000 })]);
    expect(earned).toHaveLength(1);
    expect(evaluateRewards([rule({ id: "v", metric: "SALES_VALUE", threshold: 100_000 })], [person({ salesPaisa: 9_999_999 })])).toEqual([]);
  });

  it("volume alone can't win: a delivered-rate floor blocks a high seller whose orders came back", () => {
    const rules = [rule({ id: "big", metric: "SALES_VALUE", threshold: 100_000, minDeliveredRate: 85 })];
    const bigButReturned = person({ salesPaisa: 30_000_000, delivered: 12, returned: 8 });
    const smallerButClean = { ...person({ salesPaisa: 12_000_000, delivered: 18, returned: 1 }), id: "u2" };
    expect(evaluateRewards(rules, [bigButReturned, smallerButClean]).map((e) => e.subjectId)).toEqual(["u2"]);
  });

  it("the quality floor needs a finished order and uses exact integer arithmetic", () => {
    expect(meetsQualityFloor(stats({}), 80)).toBe(false);
    expect(meetsQualityFloor(stats({}), null)).toBe(true);
    expect(meetsQualityFloor(stats({ delivered: 4, returned: 1 }), 80)).toBe(true);
    expect(meetsQualityFloor(stats({ delivered: 79, returned: 21 }), 80)).toBe(false);
  });

  it("keeps team rules for teams", () => {
    const rules = [rule({ id: "team", scope: "TEAM", metric: "ORDER_COUNT", threshold: 10 })];
    expect(evaluateRewards(rules, [person({ orderCount: 50 })])).toEqual([]);
    expect(evaluateRewards(rules, [{ scope: "TEAM", id: "t1", target: null, stats: stats({ orderCount: 50 }) }])).toHaveLength(1);
  });
});
