import { describe, expect, it } from "vitest";

import { allocate, fulfilmentStatusOf, splitOf, type AllocInput } from "@/lib/fulfilment/allocation";

// C5 — the pure allocation: oldest order first; hub, then on its way to the
// hub, then other locations in their order, then backorder.

const t = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 2, 12) - minutesAgo * 60_000);
const base = (over: Partial<AllocInput>): AllocInput => ({ hubId: "hub", otherLocationIds: ["shop", "corner"], orders: [], onHand: [], transfers: [], ...over });

describe("allocate", () => {
  it("gives the last piece to the older order, whatever order they're listed in", () => {
    const lines = allocate(
      base({
        orders: [
          { id: "new", createdAt: t(5), items: [{ id: "n1", variantId: "v", qty: 1 }] },
          { id: "old", createdAt: t(50), items: [{ id: "o1", variantId: "v", qty: 1 }] },
        ],
        onHand: [{ variantId: "v", locationId: "hub", qty: 1 }],
      }),
    );
    const by = Object.fromEntries(lines.map((l) => [l.orderId, splitOf(l)]));
    expect(fulfilmentStatusOf([by.old])).toBe("READY_TO_PACK");
    expect(fulfilmentStatusOf([by.new])).toBe("WAITING_FOR_STOCK");
  });

  it("takes the hub, then what's coming to it, then other locations in order, then backorders", () => {
    const [line] = allocate(
      base({
        orders: [{ id: "o", createdAt: t(1), items: [{ id: "i", variantId: "v", qty: 7 }] }],
        onHand: [
          { variantId: "v", locationId: "hub", qty: 1 },
          { variantId: "v", locationId: "corner", qty: 2 },
          { variantId: "v", locationId: "shop", qty: 3 },
        ],
        transfers: [
          // A Draft from the shop to the hub: 1 asked, 2 already scanned → 2 promised, and the shop can't offer them again.
          { variantId: "v", status: "DRAFT", fromLocationId: "shop", toLocationId: "hub", qtyRequested: 1, qtySent: 2 },
        ],
      }),
    );
    expect(line).toMatchObject({ atHub: 1, incoming: 2, fromLocations: [{ locationId: "shop", qty: 1 }, { locationId: "corner", qty: 2 }], backorder: 1 });
  });

  it("never counts negative stock, and a Draft out of the hub takes from the hub", () => {
    const [line] = allocate(
      base({
        orders: [{ id: "o", createdAt: t(1), items: [{ id: "i", variantId: "v", qty: 2 }] }],
        onHand: [
          { variantId: "v", locationId: "hub", qty: 2 },
          { variantId: "v", locationId: "shop", qty: -3 },
        ],
        transfers: [{ variantId: "v", status: "DRAFT", fromLocationId: "hub", toLocationId: "corner", qtyRequested: 1, qtySent: 0 }],
      }),
    );
    expect(line).toMatchObject({ atHub: 1, incoming: 0, fromLocations: [], backorder: 1 });
  });

  it("treats each variant on its own", () => {
    const lines = allocate(
      base({
        orders: [
          { id: "a", createdAt: t(9), items: [{ id: "a1", variantId: "x", qty: 1 }, { id: "a2", variantId: "y", qty: 1 }] },
          { id: "b", createdAt: t(1), items: [{ id: "b1", variantId: "y", qty: 1 }] },
        ],
        onHand: [{ variantId: "y", locationId: "hub", qty: 1 }],
      }),
    );
    const s = Object.fromEntries(lines.map((l) => [l.itemId, splitOf(l)]));
    // a waits for x, but still gets the only y; b doesn't.
    expect([s.a1.backorderQty, s.a2.atHubQty, s.b1.backorderQty]).toEqual([1, 1, 1]);
  });
});
