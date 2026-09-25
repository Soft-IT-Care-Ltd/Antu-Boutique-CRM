import { describe, expect, it } from "vitest";

import { loadPackingQueuePage, serializePackingOrderDetail, serializePackingQueueItem } from "@/lib/packing/queue";

// Requires `npm run db:seed` to have run against DATABASE_URL first — same
// style as lib/orders/__tests__/orders-invariants.integration.test.ts.
//
// PRD §4.8: "the PACKING role must not see customer money data beyond what
// is printed on the packing slip" (which itself carries none). This checks
// the actual KEY NAMES the serializers produce, not a string/substring scan
// of the JSON — a substring scan would false-positive on ordinary data like
// a product named "Costume" containing "cost".

const FORBIDDEN_KEYS = new Set([
  "total",
  "subtotal",
  "dueAmount",
  "discountTotal",
  "deliveryCharge",
  "unitPrice",
  "unitCostSnapshot",
  "weightedAvgCost",
  "lineDiscount",
  "lineTotal",
  "amount",
  "payments",
  "transactionId",
]);

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entryValue] of Object.entries(value)) {
      keys.add(key);
      collectKeys(entryValue, keys);
    }
  }
}

describe("packing serializers never carry a money-shaped field", () => {
  it("the packing queue's serialized items have no forbidden key anywhere in the tree", async () => {
    const { orders } = await loadPackingQueuePage({ page: 1, pageSize: 20 }, 24);
    expect(orders.length).toBeGreaterThan(0);

    const keys = new Set<string>();
    for (const order of orders) collectKeys(serializePackingQueueItem(order, 24), keys);

    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("the packing order detail has no forbidden key anywhere in the tree", async () => {
    const { orders } = await loadPackingQueuePage({ page: 1, pageSize: 1 }, 24);
    expect(orders.length).toBeGreaterThan(0);

    const keys = new Set<string>();
    collectKeys(serializePackingOrderDetail(orders[0], 24), keys);

    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });
});
