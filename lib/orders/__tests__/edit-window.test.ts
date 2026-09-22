import { describe, expect, it } from "vitest";

import { editTouchesGatedFields, isWithinEditWindow } from "@/lib/orders/edit-window";

describe("edit window (PRD §4.6)", () => {
  it("is within the window right up to the boundary, and past it just after", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    expect(isWithinEditWindow(createdAt, 30, new Date("2026-01-01T00:29:59Z"))).toBe(true);
    expect(isWithinEditWindow(createdAt, 30, new Date("2026-01-01T00:30:00Z"))).toBe(true);
    expect(isWithinEditWindow(createdAt, 30, new Date("2026-01-01T00:30:01Z"))).toBe(false);
  });
});

describe("gated-field diffing (PRD §4.6: items/price/discount/delivery charge trigger approval)", () => {
  const existing = {
    items: [{ variantId: "v1", qty: 2, unitPrice: 1000, lineDiscount: 0 }],
    deliveryCharge: 60,
  };

  it("is not gated when nothing proposed differs from the current order", () => {
    expect(editTouchesGatedFields(existing, { items: [{ variantId: "v1", qty: 2, unitPrice: 1000, lineDiscount: 0 }] })).toBe(false);
  });

  it("is not gated by an edit that only touches non-gated fields (courier/note/date aren't part of this input)", () => {
    expect(editTouchesGatedFields(existing, {})).toBe(false);
  });

  it("is gated when qty, price, or discount changes", () => {
    expect(editTouchesGatedFields(existing, { items: [{ variantId: "v1", qty: 3, unitPrice: 1000, lineDiscount: 0 }] })).toBe(true);
    expect(editTouchesGatedFields(existing, { items: [{ variantId: "v1", qty: 2, unitPrice: 1200, lineDiscount: 0 }] })).toBe(true);
    expect(editTouchesGatedFields(existing, { items: [{ variantId: "v1", qty: 2, unitPrice: 1000, lineDiscount: 50 }] })).toBe(true);
  });

  it("is gated when delivery charge changes, not when resubmitted unchanged", () => {
    expect(editTouchesGatedFields(existing, { deliveryCharge: 100 })).toBe(true);
    expect(editTouchesGatedFields(existing, { deliveryCharge: 60 })).toBe(false);
  });

  it("ignores line order — the same set of lines in a different order isn't a change", () => {
    const twoLines = {
      items: [
        { variantId: "v1", qty: 1, unitPrice: 500, lineDiscount: 0 },
        { variantId: "v2", qty: 1, unitPrice: 800, lineDiscount: 0 },
      ],
      deliveryCharge: 0,
    };
    expect(
      editTouchesGatedFields(twoLines, {
        items: [
          { variantId: "v2", qty: 1, unitPrice: 800, lineDiscount: 0 },
          { variantId: "v1", qty: 1, unitPrice: 500, lineDiscount: 0 },
        ],
      }),
    ).toBe(false);
  });
});
