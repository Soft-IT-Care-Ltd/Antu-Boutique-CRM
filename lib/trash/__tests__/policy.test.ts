import { describe, expect, it } from "vitest";

import { daysLeftInTrash, orderTrashBlock, purgeCutoff, purgeDecision, purgeDueAt, type OrderHistoryCounts } from "@/lib/trash/policy";

const clean: OrderHistoryCounts = {
  status: "LEAD",
  leadId: null,
  exchangedFromOrderId: null,
  payments: 0,
  stockMovements: 0,
  shipment: false,
  returnCases: 0,
  returnInspections: 0,
  storeCreditEntries: 0,
  fulfilmentActions: 0,
  statementLines: 0,
  packagingExpense: false,
  exchangeOrders: 0,
  replacementFor: false,
};

describe("which orders can go to the trash (PRD §4.18)", () => {
  it("allows a never-confirmed lead order and a cancelled one with no history", () => {
    expect(orderTrashBlock(clean)).toBeNull();
    expect(orderTrashBlock({ ...clean, status: "CANCELLED" })).toBeNull();
  });

  it("refuses every status past LEAD except CANCELLED", () => {
    for (const status of ["CONFIRMED", "PACKED", "HANDED_TO_COURIER", "IN_TRANSIT", "DELIVERED", "COMPLETED", "ON_HOLD", "RETURNED", "REFUNDED", "EXCHANGE_REQUESTED", "PARTIAL_DELIVERED"] as const) {
      expect(orderTrashBlock({ ...clean, status })).toMatch(/never confirmed/);
    }
  });

  it("refuses a cancelled order that money, stock, the courier, a return or store credit touched", () => {
    const cancelled = { ...clean, status: "CANCELLED" as const };
    expect(orderTrashBlock({ ...cancelled, payments: 1 })).toMatch(/Money/);
    expect(orderTrashBlock({ ...cancelled, stockMovements: 2 })).toMatch(/Stock/);
    expect(orderTrashBlock({ ...cancelled, packagingExpense: true })).toMatch(/Stock/);
    expect(orderTrashBlock({ ...cancelled, shipment: true })).toMatch(/courier/);
    expect(orderTrashBlock({ ...cancelled, statementLines: 1 })).toMatch(/courier/);
    expect(orderTrashBlock({ ...cancelled, returnCases: 1 })).toMatch(/exchange/);
    expect(orderTrashBlock({ ...cancelled, exchangedFromOrderId: "x" })).toMatch(/exchange/);
    expect(orderTrashBlock({ ...cancelled, storeCreditEntries: 1 })).toMatch(/Store credit/);
    expect(orderTrashBlock({ ...cancelled, fulfilmentActions: 1 })).toMatch(/lost-sales record/);
  });

  it("keeps a converted lead's order (a converted lead is final)", () => {
    expect(orderTrashBlock({ ...clean, leadId: "lead1" })).toMatch(/lead/);
  });
});

describe("30 days in the trash", () => {
  const deletedAt = new Date("2026-09-01T10:00:00Z");

  it("is due 30 days after it was deleted", () => {
    expect(purgeDueAt(deletedAt).toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(purgeCutoff(new Date("2026-10-01T10:00:00Z")).toISOString()).toBe(deletedAt.toISOString());
  });

  it("counts whole days left, never below zero", () => {
    expect(daysLeftInTrash(deletedAt, deletedAt)).toBe(30);
    expect(daysLeftInTrash(deletedAt, new Date("2026-09-30T11:00:00Z"))).toBe(1);
    expect(daysLeftInTrash(deletedAt, new Date("2026-10-01T10:00:00Z"))).toBe(0);
    expect(daysLeftInTrash(deletedAt, new Date("2026-11-01T00:00:00Z"))).toBe(0);
  });
});

describe("what the purge does with a customer or product", () => {
  it("archives anything history points to, even if trashed rows point too", () => {
    expect(purgeDecision(1, 0)).toBe("archive");
    expect(purgeDecision(3, 2)).toBe("archive");
  });
  it("waits while only trashed rows point to it", () => {
    expect(purgeDecision(0, 1)).toBe("defer");
  });
  it("deletes when nothing points to it", () => {
    expect(purgeDecision(0, 0)).toBe("delete");
  });
});
