import { describe, expect, it } from "vitest";

import { decideCourierOverride } from "@/lib/orders/status-graph";
import { computeOrderTotals, keptLine } from "@/lib/orders/totals";

describe("decideCourierOverride — manual moves after Steadfast booking", () => {
  const booked = { consignmentId: "1234567", canOverride: false, reason: null };

  it("leaves unbooked orders and non-courier statuses alone", () => {
    expect(decideCourierOverride({ ...booked, consignmentId: null, toStatus: "DELIVERED" })).toEqual({ allowed: true, isOverride: false });
    expect(decideCourierOverride({ ...booked, toStatus: "ON_HOLD" })).toEqual({ allowed: true, isOverride: false });
  });

  it("blocks a courier-owned status without a reason (409), even for an Admin", () => {
    for (const toStatus of ["IN_TRANSIT", "DELIVERED", "PARTIAL_DELIVERED", "RETURNED"] as const) {
      expect(decideCourierOverride({ ...booked, toStatus, canOverride: true, reason: "  " })).toMatchObject({ allowed: false, status: 409 });
    }
  });

  it("refuses a reasoned override from anyone without order.courier_status_override (403)", () => {
    expect(decideCourierOverride({ ...booked, toStatus: "RETURNED", reason: "Parcel lost by courier" })).toMatchObject({ allowed: false, status: 403 });
  });

  it("allows an Admin override with a reason, flagged as an override", () => {
    expect(decideCourierOverride({ ...booked, toStatus: "DELIVERED", reason: "Steadfast API down 2 days", canOverride: true })).toEqual({ allowed: true, isOverride: true });
  });
});

describe("keptLine — partial delivery bills what the customer kept", () => {
  it("is exactly qty × price − discount when nothing came back", () => {
    expect(keptLine({ qty: 2, returnedQty: 0, unitPrice: 1450, lineDiscount: 101 })).toEqual({ qty: 2, unitPrice: 1450, lineDiscount: 101, lineTotal: 2799 });
  });

  it("pro-rates the discount to the kept quantity, and lines always sum to the order total", () => {
    const lines = [
      keptLine({ qty: 3, returnedQty: 1, unitPrice: 1000, lineDiscount: 100 }),
      keptLine({ qty: 1, returnedQty: 1, unitPrice: 2950, lineDiscount: 50 }),
    ];
    expect(lines[0]).toMatchObject({ qty: 2, lineDiscount: 66.67, lineTotal: 1933.33 });
    expect(lines[1]).toMatchObject({ qty: 0, lineDiscount: 0, lineTotal: 0 });
    const totals = computeOrderTotals(lines, 60);
    expect(Math.round(totals.total * 100) / 100).toBe(Math.round((lines[0].lineTotal + lines[1].lineTotal + 60) * 100) / 100);
  });
});
