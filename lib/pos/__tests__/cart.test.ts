import { describe, expect, it } from "vitest";

import { CartError, priceCart, settleTenders } from "@/lib/pos/cart";

describe("POS cart pricing", () => {
  it("spreads a whole-sale discount over the lines in whole paisa that add back exactly", () => {
    const cart = priceCart(
      [
        { key: "a", qty: 2, unitPrice: 1450, lineDiscount: 0 },
        { key: "b", qty: 1, unitPrice: 999.99, lineDiscount: 49.99 },
        { key: "c", qty: 3, unitPrice: 333.33, lineDiscount: 0 },
      ],
      100,
    );
    expect(cart.subtotalPaisa).toBe(290000 + 99999 + 99999);
    const cartShare = cart.lines.reduce((a, l) => a + l.discountPaisa, 0) - 4999;
    expect(cartShare).toBe(10000);
    expect(cart.totalPaisa).toBe(cart.subtotalPaisa - 4999 - 10000);
    for (const l of cart.lines) expect(l.netPaisa).toBe(l.grossPaisa - l.discountPaisa);
    // The biggest line carries the biggest share.
    expect(cart.lines[0].discountPaisa).toBeGreaterThan(cart.lines[2].discountPaisa);
  });

  it("allows a discount of the whole sale, never more", () => {
    expect(priceCart([{ key: "a", qty: 1, unitPrice: 500, lineDiscount: 0 }], 500).totalPaisa).toBe(0);
    expect(() => priceCart([{ key: "a", qty: 1, unitPrice: 500, lineDiscount: 0 }], 500.01)).toThrow(CartError);
    expect(() => priceCart([{ key: "a", qty: 1, unitPrice: 500, lineDiscount: 600 }], 0)).toThrow(CartError);
  });
});

describe("POS tenders", () => {
  it("settles split tenders and works out cash change", () => {
    const s = settleTenders(190000, [
      { method: "CASH", amount: 1400, tendered: 1500 },
      { method: "BKASH", amount: 500 },
    ]);
    expect(s).toEqual({ paidPaisa: 190000, changePaisa: 10000, remainingPaisa: 0 });
  });

  it("reports what is still to pay, or paid too much", () => {
    expect(settleTenders(100000, [{ method: "CARD", amount: 600 }]).remainingPaisa).toBe(40000);
    expect(settleTenders(100000, [{ method: "CARD", amount: 1200 }]).remainingPaisa).toBe(-20000);
  });
});
