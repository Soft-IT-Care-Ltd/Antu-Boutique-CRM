import { describe, expect, it } from "vitest";

import { priceSetComponents, setsAvailable } from "@/lib/sets/pricing";

// P3.3 — a set's price split over its component lines must add back up to
// exactly what the set line charges, whatever the rounding.

const net = (lines: { netPaisa: number }[]) => lines.reduce((a, l) => a + l.netPaisa, 0);

describe("priceSetComponents", () => {
  it("splits the set price by list value, whole paisa, adding back up exactly", () => {
    const lines = priceSetComponents({
      unitPricePaisa: 3_500_00,
      qty: 1,
      discountPaisa: 0,
      components: [
        { key: "kurti", qtyPerSet: 1, listPricePaisa: 2_200_00 },
        { key: "dupatta", qtyPerSet: 1, listPricePaisa: 800_00 },
        { key: "plazo", qtyPerSet: 1, listPricePaisa: 1_000_00 },
      ],
    });
    expect(lines.map((l) => l.unitPricePaisa)).toEqual([1_925_00, 700_00, 875_00]);
    expect(lines.every((l) => l.discountPaisa === 0)).toBe(true);
    expect(net(lines)).toBe(3_500_00);
  });

  it("keeps the total exact when a share doesn't divide by the units per set, and with a discount", () => {
    for (const [price, qty, discount] of [
      [1_000_01, 3, 0],
      [2_999_99, 2, 150_01],
      [1_00, 7, 3],
    ] as const) {
      const lines = priceSetComponents({
        unitPricePaisa: price,
        qty,
        discountPaisa: discount,
        components: [
          { key: "a", qtyPerSet: 3, listPricePaisa: 333_33 },
          { key: "b", qtyPerSet: 1, listPricePaisa: 1_000_00 },
          { key: "c", qtyPerSet: 2, listPricePaisa: 0 },
        ],
      });
      expect(net(lines)).toBe(price * qty - discount);
      for (const l of lines) {
        expect(Number.isInteger(l.unitPricePaisa)).toBe(true);
        expect(l.discountPaisa).toBeGreaterThanOrEqual(0);
        expect(l.discountPaisa).toBeLessThanOrEqual(l.unitPricePaisa * l.qty);
      }
      expect(lines.map((l) => l.qty)).toEqual([3 * qty, qty, 2 * qty]);
    }
  });

  it("splits equally when no component has a list price", () => {
    const lines = priceSetComponents({ unitPricePaisa: 90_00, qty: 1, discountPaisa: 0, components: [{ key: "a", qtyPerSet: 1, listPricePaisa: 0 }, { key: "b", qtyPerSet: 1, listPricePaisa: 0 }] });
    expect(lines.map((l) => l.unitPricePaisa)).toEqual([45_00, 45_00]);
  });

  it("refuses a discount above the line", () => {
    expect(() => priceSetComponents({ unitPricePaisa: 100, qty: 1, discountPaisa: 101, components: [{ key: "a", qtyPerSet: 1, listPricePaisa: 1 }] })).toThrow();
  });
});

describe("setsAvailable", () => {
  it("is the minimum over components of floor(available ÷ units per set)", () => {
    expect(setsAvailable([{ available: 10, qtyPerSet: 1 }, { available: 7, qtyPerSet: 2 }, { available: 5, qtyPerSet: 1 }])).toBe(3);
    expect(setsAvailable([{ available: 1, qtyPerSet: 2 }])).toBe(0);
    expect(setsAvailable([{ available: -3, qtyPerSet: 1 }])).toBe(0);
  });
});
