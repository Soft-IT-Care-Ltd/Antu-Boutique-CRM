import { describe, expect, it } from "vitest";

import { variantStockStatus } from "@/lib/inventory/constants";
import { rollUpProductStock, type RollUpVariantInput } from "@/lib/inventory/low-stock";

function v(sizeName: string, colorName: string, available: number, threshold = 3): RollUpVariantInput {
  return { variantId: `${sizeName}-${colorName}`, sku: `SKU-${sizeName}-${colorName}`, sizeName, colorName, colorHex: "#000", available, threshold };
}

describe("per-variant stock status", () => {
  it("is OUT at or below zero available, LOW up to the threshold, OK above", () => {
    expect(variantStockStatus(-1, 3)).toBe("OUT");
    expect(variantStockStatus(0, 3)).toBe("OUT");
    expect(variantStockStatus(3, 3)).toBe("LOW");
    expect(variantStockStatus(4, 3)).toBe("OK");
  });
});

describe("product-level low-stock roll-up (PRD §4.2)", () => {
  it("returns nothing when no variant is low", () => {
    expect(rollUpProductStock([v("M", "Maroon", 10), v("L", "Maroon", 8)])).toBeNull();
  });

  it("says 'Only XL left' when one size of a one-colour product remains", () => {
    const rollUp = rollUpProductStock([v("M", "Maroon", 0), v("L", "Maroon", 0), v("XL", "Maroon", 2)]);
    expect(rollUp?.message).toBe("Only XL left");
    expect(rollUp?.outCount).toBe(2);
    expect(rollUp?.lowCount).toBe(1);
  });

  it("names colours when there's only one size", () => {
    const rollUp = rollUpProductStock([v("Free", "Navy Blue", 0), v("Free", "Black", 7), v("Free", "Maroon", 0)]);
    expect(rollUp?.message).toBe("Only Black left");
  });

  it("names size / colour when both vary", () => {
    const rollUp = rollUpProductStock([v("M", "Black", 0), v("L", "Black", 5), v("M", "White", 0), v("L", "White", 9)]);
    expect(rollUp?.message).toBe("Only L / Black and L / White left");
  });

  it("summarises counts when plenty still remains", () => {
    const rollUp = rollUpProductStock([v("S", "Black", 0), v("M", "Black", 2), v("L", "Black", 9), v("XL", "Black", 9), v("XXL", "Black", 9)]);
    expect(rollUp?.message).toBe("1 out of stock, 1 low (of 5 variants)");
  });

  it("handles a single-variant product and a fully sold-out product", () => {
    expect(rollUpProductStock([v("Free", "Black", 2)])?.message).toBe("Only 2 left");
    expect(rollUpProductStock([v("Free", "Black", 0)])?.message).toBe("Out of stock");
    expect(rollUpProductStock([v("M", "Black", 0), v("L", "Black", 0)])?.message).toBe("Out of stock in every variant");
  });
});
