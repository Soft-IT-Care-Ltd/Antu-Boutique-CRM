import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { SHORTAGE_EXPENSE_CATEGORY } from "@/lib/inventory/constants";
import { findStockLedgerDivergences, recordStockMovement, StockMovementError } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { createStockCount, postStockCount, scanCountUnit, setCountLineQty, StockCountError } from "@/lib/stock-counts/service";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { PHONES, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";
import { createHubTransfer, getHubNeeds } from "@/lib/transfers/hub-needs";
import { cancelTransfer, createTransfer, getTransferView, receiveTransfer, resolveMissing, scanTransferUnit, sendTransfer, setTransferLineQty, TransferError } from "@/lib/transfers/service";
import { ScanError } from "@/lib/inventory/scan-lookup";

// C4 — CORRECTIONS.md item 3 (transfers) and item 2 (stock count by scan).
// The invariant everything here protects (CLAUDE.md rule 2, C3 per
// location, C4 in transit):
//   * each location's stock = the sum of that location's ledger rows
//   * in transit             = the sum of the rows with no location
//   * total                  = sum of locations + in transit = sum of all rows
// and a transfer never changes the total — only a write-off of units lost
// on the road does.

const TIMEOUT = 120_000;
const HUB = SEEDED_LOCATION_IDS.mohammadpur;
const SHOWROOM = SEEDED_LOCATION_IDS.shyamoli;
const CORNER = SEEDED_LOCATION_IDS.parlour;

type Tx = Prisma.TransactionClient;

async function ledgerSum(tx: Tx, variantId: string, locationId?: string | null) {
  const agg = await tx.stockMovement.aggregate({ where: { variantId, ...(locationId !== undefined ? { locationId } : {}) }, _sum: { qty: true } });
  return agg._sum.qty ?? 0;
}

async function qtyAt(tx: Tx, variantId: string, locationId: string) {
  return (await tx.variantStock.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))?.qty ?? 0;
}

/** Where a variant's stock is — and proof, three ways, that it matches the ledger. */
async function snapshot(tx: Tx, variantId: string) {
  const v = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  const stocks = await tx.variantStock.findMany({ where: { variantId } });
  for (const s of stocks) expect(await ledgerSum(tx, variantId, s.locationId), `at ${s.locationId}`).toBe(s.qty);
  expect(await ledgerSum(tx, variantId, null), "in transit").toBe(v.inTransitQty);
  expect(await ledgerSum(tx, variantId), "total").toBe(v.stockQty);
  expect(stocks.reduce((a, s) => a + s.qty, 0) + v.inTransitQty, "locations + in transit").toBe(v.stockQty);
  await checkDeferredConstraintsNow(tx);
  return { total: v.stockQty, inTransit: v.inTransitQty, hub: await qtyAt(tx, variantId, HUB), showroom: await qtyAt(tx, variantId, SHOWROOM), corner: await qtyAt(tx, variantId, CORNER) };
}

async function scratchVariant(tx: Tx, stock: { locationId: string; qty: number }[], cost = 500) {
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow({ orderBy: { sortOrder: "asc" } }), tx.color.findFirstOrThrow({ orderBy: { sortOrder: "asc" } })]);
  const code = testProductCode();
  const product = await tx.product.create({ data: { code, name: `Transfer test ${code}`, basePrice: 1500 } });
  const v = await tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: testSku(code), weightedAvgCost: cost } });
  for (const s of stock) await recordStockMovement(tx, { variantId: v.id, locationId: s.locationId, type: "PURCHASE_IN", qty: s.qty, unitCost: cost, referenceType: "OPENING_BALANCE", actorId: null });
  return v;
}

async function scan(tx: Tx, user: Awaited<ReturnType<typeof userFor>>, transferId: string, side: "send" | "receive", sku: string, times: number) {
  for (let i = 0; i < times; i++) await scanTransferUnit(tx, user, transferId, side, sku);
}

describe("stock transfers (CORRECTIONS.md item 3)", () => {
  it(
    "send → in transit → short receipt → found + write-off: every location = its ledger, total unchanged until the write-off",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [pos, packer, manager] = await Promise.all([userFor(tx, PHONES.POS), userFor(tx, PHONES.PACKING), userFor(tx, PHONES.MANAGER)]);
        const v = await scratchVariant(tx, [{ locationId: SHOWROOM, qty: 6 }]);
        const w = await scratchVariant(tx, [{ locationId: SHOWROOM, qty: 2 }], 800);
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 6, inTransit: 0, showroom: 6, hub: 0 });

        // Draft: the showroom incharge scans 5 of v and 2 of w. A scanner
        // may send lower case (Caps Lock) — it still reads.
        const t = await createTransfer(tx, pos, { fromLocationId: SHOWROOM, toLocationId: HUB });
        expect(t.transferNo).toMatch(/^TR-\d{4}-\d{4}$/);
        await scan(tx, pos, t.id, "send", v.sku.toLowerCase(), 5);
        await scan(tx, pos, t.id, "send", w.sku, 2);
        // A third w isn't there to send.
        await expect(scanTransferUnit(tx, pos, t.id, "send", w.sku)).rejects.toThrow(ScanError);
        // Nothing has moved yet.
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 6, inTransit: 0, showroom: 6 });

        // Only the source sends: the hub's packer can't.
        await expect(sendTransfer(tx, packer, t.id)).rejects.toThrow(TransferError);
        // …and nobody receives a draft.
        await expect(scanTransferUnit(tx, packer, t.id, "receive", v.sku)).rejects.toThrow(TransferError);

        // SEND: out of the showroom, into transit, at no location. Total unchanged.
        await sendTransfer(tx, pos, t.id);
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 6, inTransit: 5, showroom: 1, hub: 0 });
        expect(await snapshot(tx, w.id)).toMatchObject({ total: 2, inTransit: 2, showroom: 0, hub: 0 });
        const sendRows = await tx.stockMovement.findMany({ where: { referenceType: "TRANSFER", referenceId: t.id, variantId: v.id }, orderBy: { qty: "asc" } });
        expect(sendRows.map((r) => [r.type, r.locationId, r.qty])).toEqual([
          ["TRANSFER_SEND", SHOWROOM, -5],
          ["TRANSFER_SEND", null, 5],
        ]);
        // The showroom incharge (no product.cost.view) never gets the cost it was sent at;
        // a Sales Executive (no location) doesn't see the transfer at all.
        const posView = await getTransferView(tx, pos, t.id, { withCost: false });
        expect(posView?.lines.length).toBe(2);
        expect(JSON.stringify(posView)).not.toMatch(/unitCost|weightedAvgCost/);
        expect((await getTransferView(tx, manager, t.id, { withCost: true }))?.lines.find((l) => l.variantId === v.id)?.unitCost).toBe("500");
        expect(await getTransferView(tx, await userFor(tx, PHONES.SE), t.id, { withCost: false })).toBeNull();
        // A sent transfer can't be scanned out any more, or cancelled.
        await expect(scanTransferUnit(tx, pos, t.id, "send", v.sku)).rejects.toThrow(TransferError);
        await expect(cancelTransfer(tx, pos, t.id, "changed mind")).rejects.toThrow(TransferError);

        // RECEIVE: only the destination. The showroom can't receive its own send.
        await expect(scanTransferUnit(tx, pos, t.id, "receive", v.sku)).rejects.toThrow(TransferError);
        // The packer unpacks: 3 of the 5 v arrive, 1 of the 2 w.
        await scan(tx, packer, t.id, "receive", v.sku, 3);
        await scan(tx, packer, t.id, "receive", w.sku, 1);
        // A tag that isn't on the transfer is refused…
        const stranger = await scratchVariant(tx, [{ locationId: HUB, qty: 1 }]);
        await expect(scanTransferUnit(tx, packer, t.id, "receive", stranger.sku)).rejects.toThrow(/isn't on/);
        // …as is one scanned more times than it was sent (typed as 2, then 3 more).
        await setTransferLineQty(tx, packer, t.id, "receive", w.id, 2);
        await expect(scanTransferUnit(tx, packer, t.id, "receive", w.sku)).rejects.toThrow(/already scanned/);
        await setTransferLineQty(tx, packer, t.id, "receive", w.id, 1);
        // Scanning in moves nothing until Receive.
        expect(await snapshot(tx, v.id)).toMatchObject({ inTransit: 5, hub: 0 });

        const received = await receiveTransfer(tx, packer, t.id);
        expect(received).toEqual({ status: "RECEIVED_WITH_DIFFERENCE", missing: 3 });
        // SHORT RECEIPT: 3 at the hub, 2 still missing in transit. Total unchanged.
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 6, inTransit: 2, showroom: 1, hub: 3 });
        expect(await snapshot(tx, w.id)).toMatchObject({ total: 2, inTransit: 1, showroom: 0, hub: 1 });

        // RESOLVE: only a manager (transfer.resolve) — not the packer.
        await expect(resolveMissing(tx, packer, t.id, { variantId: v.id, action: "FOUND", qty: 1, reason: "in the van" })).rejects.toThrow(TransferError);
        // One v turns up in the van: FOUND → onto the hub.
        await resolveMissing(tx, manager, t.id, { variantId: v.id, action: "FOUND", qty: 1, reason: "Found under the van seat" });
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 6, inTransit: 1, hub: 4 });
        // Can't resolve more than is missing.
        await expect(resolveMissing(tx, manager, t.id, { variantId: v.id, action: "WRITE_OFF", qty: 2, reason: "lost" })).rejects.toThrow(/Only 1/);

        // WRITE OFF the last v: out of stock for good, expense at the cost it was sent at.
        await resolveMissing(tx, manager, t.id, { variantId: v.id, action: "WRITE_OFF", qty: 1, reason: "Lost on the way" });
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 5, inTransit: 0, showroom: 1, hub: 4 });
        const writeOff = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: t.id, variantId: v.id, type: "TRANSIT_WRITE_OFF" }, include: { expense: { include: { category: true } } } });
        expect(writeOff).toMatchObject({ locationId: null, qty: -1 });
        expect(writeOff.expense?.amount.toString()).toBe("500");
        expect(writeOff.expense?.category.name).toBe(SHORTAGE_EXPENSE_CATEGORY);

        await resolveMissing(tx, manager, t.id, { variantId: w.id, action: "WRITE_OFF", qty: 1, reason: "Lost on the way" });
        expect(await snapshot(tx, w.id)).toMatchObject({ total: 1, inTransit: 0, hub: 1 });

        const lines = await tx.stockTransferLine.findMany({ where: { transferId: t.id }, orderBy: { qtySent: "desc" } });
        expect(lines.map((l) => [l.qtySent, l.qtyReceived, l.qtyFound, l.qtyWrittenOff])).toEqual([
          [5, 3, 1, 1],
          [2, 1, 0, 1],
        ]);
        expect(await tx.auditLog.count({ where: { entityType: "stock_transfer", entityId: t.id } })).toBe(5);
        expect(await findStockLedgerDivergences(tx)).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "a clean transfer is Received; a draft can be cancelled and moves nothing; in-transit rows are only ever transfer rows",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [admin, packer] = await Promise.all([userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.PACKING)]);
        const v = await scratchVariant(tx, [{ locationId: HUB, qty: 4 }]);

        // Admin acts for every location: sends from the hub, receives at the corner.
        const t = await createTransfer(tx, admin, { fromLocationId: HUB, toLocationId: CORNER });
        await scan(tx, admin, t.id, "send", v.sku, 4);
        await setTransferLineQty(tx, admin, t.id, "send", v.id, 2);
        await sendTransfer(tx, admin, t.id);
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 4, inTransit: 2, hub: 2, corner: 0 });
        // The hub packer isn't the corner's — can't receive there.
        await expect(receiveTransfer(tx, packer, t.id)).rejects.toThrow(TransferError);
        await scan(tx, admin, t.id, "receive", v.sku, 2);
        expect(await receiveTransfer(tx, admin, t.id)).toEqual({ status: "RECEIVED", missing: 0 });
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 4, inTransit: 0, hub: 2, corner: 2 });

        const draft = await createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: SHOWROOM });
        await scan(tx, packer, draft.id, "send", v.sku, 2);
        await expect(sendTransfer(tx, packer, draft.id)).resolves.toBeUndefined();
        const empty = await createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: SHOWROOM });
        await expect(sendTransfer(tx, packer, empty.id)).rejects.toThrow(/at least one/);
        await cancelTransfer(tx, packer, empty.id, "Opened by mistake");
        expect((await tx.stockTransfer.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe("CANCELLED");

        // Only transfer rows may sit in transit.
        await expect(recordStockMovement(tx, { variantId: v.id, locationId: null, type: "ADJUSTMENT", qty: 1, unitCost: 1, referenceType: "ADJUSTMENT", actorId: null })).rejects.toThrow(StockMovementError);
        await expect(recordStockMovement(tx, { variantId: v.id, locationId: HUB, type: "TRANSIT_WRITE_OFF", qty: -1, unitCost: 1, referenceType: "TRANSFER", actorId: null })).rejects.toThrow(StockMovementError);
        // A same-place transfer is refused.
        await expect(createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: HUB })).rejects.toThrow(TransferError);
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 4, inTransit: 2, hub: 0, corner: 2 });
      });
    },
    TIMEOUT,
  );

  it(
    "a Sales Executive can't send, receive or count",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const se = await userFor(tx, PHONES.SE);
        await expect(createTransfer(tx, se, { fromLocationId: HUB, toLocationId: SHOWROOM })).rejects.toMatchObject({ status: 403 });
        await expect(createStockCount(tx, se, { locationId: HUB, scope: "SPOT" })).rejects.toMatchObject({ status: 403 });
      });
    },
    TIMEOUT,
  );
});

describe("Needed at the packing hub (item 3 → item 13)", () => {
  it(
    "offers another location's stock to the oldest waiting orders, and a transfer raised for them takes them off the list",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [admin, pos] = await Promise.all([userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.POS)]);
        const customer = await tx.customer.findFirstOrThrow({});
        // 1 at the hub, 2 at the showroom.
        const v = await scratchVariant(tx, [
          { locationId: HUB, qty: 1 },
          { locationId: SHOWROOM, qty: 2 },
        ]);
        const order = (n: number, minutesAgo: number) =>
          tx.order.create({
            data: { orderNo: `TEST-HUB-${Date.now()}-${n}`, status: "CONFIRMED", channel: "ONLINE", customerId: customer.id, createdAt: new Date(Date.now() - minutesAgo * 60_000), items: { create: [{ variantId: v.id, qty: 1, unitPrice: 1500 }] } },
          });
        // Oldest first: o1 gets the hub's one; o2 and o3 need one each from elsewhere; o4 nothing is left for.
        const o1 = await order(1, 40);
        const o2 = await order(2, 30);
        const o3 = await order(3, 20);
        const o4 = await order(4, 10);

        const mine = <T extends { variantId: string }>(rows: T[]) => rows.filter((r) => r.variantId === v.id);
        const needs = await getHubNeeds(tx, SHOWROOM);
        expect(mine(needs.rows).map((r) => [r.orderId, r.qtyHere])).toEqual([
          [o2.id, 1],
          [o3.id, 1],
        ]);
        expect(needs.rows.some((r) => r.orderId === o1.id || r.orderId === o4.id)).toBe(false);

        // A pick for an order the showroom can't serve is refused.
        await expect(createHubTransfer(tx, pos, { fromLocationId: SHOWROOM, picks: [{ orderId: o4.id, variantId: v.id, qty: 1 }] })).rejects.toThrow(TransferError);
        // Tick o2 → a Draft to the hub, pre-filled and linked.
        const t = await createHubTransfer(tx, pos, { fromLocationId: SHOWROOM, picks: [{ orderId: o2.id, variantId: v.id, qty: 1 }] });
        const draft = await tx.stockTransfer.findUniqueOrThrow({ where: { id: t.id }, include: { lines: true, orders: true } });
        expect(draft).toMatchObject({ status: "DRAFT", fromLocationId: SHOWROOM, toLocationId: HUB });
        expect(draft.lines.map((l) => [l.variantId, l.qtyRequested, l.qtySent])).toEqual([[v.id, 1, 0]]);
        expect(draft.orders.map((o) => o.orderId)).toEqual([o2.id]);

        // The draft counts as supply coming: o2 is covered, o3 moves up; still the showroom's second unit for it.
        expect(mine((await getHubNeeds(tx, SHOWROOM)).rows).map((r) => r.orderId)).toEqual([o3.id]);

        // Send and receive it: the hub now holds 2 — o1 and o2 are ready; o3 still waits on the showroom.
        await scan(tx, pos, t.id, "send", v.sku, 1);
        await sendTransfer(tx, pos, t.id);
        await scan(tx, admin, t.id, "receive", v.sku, 1);
        await receiveTransfer(tx, admin, t.id);
        expect(await snapshot(tx, v.id)).toMatchObject({ total: 3, hub: 2, showroom: 1, inTransit: 0 });
        expect(mine((await getHubNeeds(tx, SHOWROOM)).rows).map((r) => [r.orderId, r.qtyHere])).toEqual([[o3.id, 1]]);
      });
    },
    TIMEOUT,
  );
});

describe("stock count by scan (item 2)", () => {
  it(
    "a spot count posts counted − expected as adjustments; a full count zeroes what wasn't scanned",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [packer, manager] = await Promise.all([userFor(tx, PHONES.PACKING), userFor(tx, PHONES.MANAGER)]);
        const a = await scratchVariant(tx, [{ locationId: HUB, qty: 5 }]);
        const b = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        const c = await scratchVariant(tx, [{ locationId: HUB, qty: 3 }]);

        // SPOT: the packer counts 3 of a and 4 of b.
        const spot = await createStockCount(tx, packer, { locationId: HUB, scope: "SPOT" });
        expect(spot.countNo).toMatch(/^SC-\d{4}-\d{4}$/);
        for (let i = 0; i < 3; i++) await scanCountUnit(tx, packer, spot.id, a.sku);
        await setCountLineQty(tx, packer, spot.id, b.id, 4);
        await expect(scanCountUnit(tx, packer, spot.id, "NOSUCH1")).rejects.toThrow(ScanError);
        // Posting is an adjustment: the packer can't, the manager can.
        await expect(postStockCount(tx, packer, spot.id)).rejects.toThrow(StockCountError);
        expect(await postStockCount(tx, manager, spot.id)).toEqual({ compared: 2, differences: 2 });
        expect(await snapshot(tx, a.id)).toMatchObject({ hub: 3, total: 3 });
        expect(await snapshot(tx, b.id)).toMatchObject({ hub: 4, total: 4 });
        // c wasn't in a spot count — untouched.
        expect(await snapshot(tx, c.id)).toMatchObject({ hub: 3 });
        const adj = await tx.stockMovement.findMany({ where: { referenceType: "STOCK_COUNT", referenceId: spot.id }, include: { expense: true } });
        expect(adj.map((m) => m.qty).sort()).toEqual([-2, 2]);
        expect(adj.every((m) => m.type === "ADJUSTMENT" && m.expense !== null)).toBe(true);
        await expect(scanCountUnit(tx, packer, spot.id, a.sku)).rejects.toThrow(/already posted/);

        // FULL at the corner: only a scanned; b and c there were never scanned → taken off.
        await recordStockMovement(tx, { variantId: a.id, locationId: CORNER, type: "PURCHASE_IN", qty: 1, unitCost: 500, referenceType: "OPENING_BALANCE", actorId: null });
        await recordStockMovement(tx, { variantId: c.id, locationId: CORNER, type: "PURCHASE_IN", qty: 2, unitCost: 500, referenceType: "OPENING_BALANCE", actorId: null });
        const full = await createStockCount(tx, manager, { locationId: CORNER, scope: "FULL" });
        await scanCountUnit(tx, manager, full.id, a.sku);
        await postStockCount(tx, manager, full.id);
        expect(await snapshot(tx, a.id)).toMatchObject({ corner: 1, hub: 3 });
        expect(await snapshot(tx, c.id)).toMatchObject({ corner: 0, hub: 3 });
        expect(await findStockLedgerDivergences(tx)).toEqual([]);
      });
    },
    TIMEOUT,
  );
});
