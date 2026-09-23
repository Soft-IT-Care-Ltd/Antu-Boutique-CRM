import { describe, expect, it } from "vitest";

import { computeWeightedAverageCost, computeWeightedAverageCostPaisa, costPurchase, fromPaisa, splitProportionally, toPaisa } from "@/lib/inventory/costing";

describe("weighted average cost (PRD §4.3)", () => {
  it("follows new_wac = (old_qty × old_wac + in_qty × in_cost) ÷ (old_qty + in_qty)", () => {
    // (10 × 600 + 5 × 690) ÷ 15 = 630
    expect(computeWeightedAverageCost(10, 600, 5, 690)).toBe("630.00");
    // (3 × 100 + 1 × 101) ÷ 4 = 100.25
    expect(computeWeightedAverageCost(3, "100.00", 1, "101.00")).toBe("100.25");
  });

  it("rounds to the paisa", () => {
    // (10 × 105 + 5 × 130) ÷ 15 = 113.333…
    expect(computeWeightedAverageCost(10, 105, 5, 130)).toBe("113.33");
  });

  it("takes the incoming cost outright when nothing (or less than nothing) is on hand", () => {
    expect(computeWeightedAverageCost(0, 999, 4, 250)).toBe("250.00");
    expect(computeWeightedAverageCost(-2, 999, 4, 250)).toBe("250.00");
  });

  it("rejects a non-positive incoming quantity", () => {
    expect(() => computeWeightedAverageCostPaisa(5, 100, 0, 100)).toThrow();
    expect(() => computeWeightedAverageCostPaisa(5, 100, -1, 100)).toThrow();
  });
});

describe("paisa helpers", () => {
  it("round-trips without float drift", () => {
    expect(toPaisa("0.10") + toPaisa("0.20")).toBe(30);
    expect(fromPaisa(toPaisa("1234.5"))).toBe("1234.50");
    expect(fromPaisa(-5)).toBe("-0.05");
  });
});

describe("transport/other cost allocation", () => {
  it("always sums back to exactly the amount being split", () => {
    const shares = splitProportionally(10_000, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });

  it("splits by line value by default", () => {
    // lines worth 1000 and 3000 share 400 of transport 1:3
    const costed = costPurchase(
      [
        { qty: 10, unitCost: 100 },
        { qty: 10, unitCost: 300 },
      ],
      400,
      0,
      "BY_VALUE",
    );
    expect(costed.lines.map((l) => l.allocatedPaisa)).toEqual([10_000, 30_000]);
    expect(costed.lines.map((l) => fromPaisa(l.landedUnitCostPaisa))).toEqual(["110.00", "330.00"]);
    expect(fromPaisa(costed.itemsSubtotalPaisa)).toBe("4000.00");
    expect(fromPaisa(costed.totalCostPaisa)).toBe("4400.00");
  });

  it("splits by quantity when asked, and adds transport + other together", () => {
    const costed = costPurchase(
      [
        { qty: 1, unitCost: 1000 },
        { qty: 3, unitCost: 100 },
      ],
      30,
      10,
      "BY_QTY",
    );
    expect(costed.lines.map((l) => l.allocatedPaisa)).toEqual([1_000, 3_000]);
    expect(fromPaisa(costed.extraCostPaisa)).toBe("40.00");
  });

  it("falls back to an even split when every line is free", () => {
    const costed = costPurchase(
      [
        { qty: 2, unitCost: 0 },
        { qty: 2, unitCost: 0 },
      ],
      100,
      0,
      "BY_VALUE",
    );
    expect(costed.lines.map((l) => l.allocatedPaisa)).toEqual([5_000, 5_000]);
  });
});
