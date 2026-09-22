import { describe, expect, it } from "vitest";

import { stripCostFields } from "@/lib/auth/strip-cost-fields";

const sampleVariant = {
  id: "v1",
  sku: "PRD-1-M-MAROON",
  stockQty: 12,
  priceOverride: 1450,
  weightedAvgCost: 620,
  product: {
    name: "Kurti #12",
    basePrice: 1500,
    costPrice: 700,
  },
  nested: [{ profit: 800 }, { margin: 0.35, label: "keep me" }],
};

describe("stripCostFields", () => {
  it("removes every cost/profit/margin/purchase-price key, recursively, when the caller lacks cost access", () => {
    const output = stripCostFields(sampleVariant, false) as Record<string, unknown>;

    expect(output).not.toHaveProperty("weightedAvgCost");
    expect((output.product as Record<string, unknown>)).not.toHaveProperty("costPrice");
    expect(output.nested as unknown[]).toEqual([{}, { label: "keep me" }]);

    // Non-cost fields survive untouched.
    expect(output.sku).toBe("PRD-1-M-MAROON");
    expect(output.priceOverride).toBe(1450);
    expect((output.product as Record<string, unknown>).basePrice).toBe(1500);
  });

  it("leaves the object untouched when the caller has cost access", () => {
    const output = stripCostFields(sampleVariant, true);
    expect(output).toBe(sampleVariant);
    expect(output).toHaveProperty("weightedAvgCost", 620);
  });
});
