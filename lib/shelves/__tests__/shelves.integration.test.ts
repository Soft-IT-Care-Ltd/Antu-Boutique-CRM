import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/types";
import { findStockLedgerDivergences, recordStockMovement } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { packOrder } from "@/lib/orders/pack";
import { reserveVariantStock } from "@/lib/orders/stock";
import { createPosSale } from "@/lib/pos/sale";
import { findShelfDivergences, readShelfLayer } from "@/lib/shelves/engine";
import { createShelves, finishShelfCount, getShelfCountView, getShelfLocationView, putAway, scanShelfCount, ShelfError, shelfWhereabouts, startShelfCount, writeOffMiss } from "@/lib/shelves/service";
import { createStockCount, postStockCount, scanCountUnit } from "@/lib/stock-counts/service";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { PHONES, userFor } from "@/lib/test/returns-fixtures";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";
import { createTransfer, receiveTransfer, scanTransferUnit, sendTransfer } from "@/lib/transfers/service";

// C4b — CORRECTIONS.md item 20A, shelves inside a location. What every
// test here protects (the owner's rules, 2 Oct 2026):
//   * Unassigned = location stock − sum(shelves): derived, so it can't drift
//   * a shelf is never below zero, and the shelves (+ units "not on their
//     shelf") never hold more than the location — held by the database
//   * stock leaving takes the picked shelf, else Unassigned, then the fullest shelf
//   * a shelf count never changes stock, and a sale or move during it is
//     never read as a difference

const TIMEOUT = 120_000;
const HUB = SEEDED_LOCATION_IDS.mohammadpur;
const SHOWROOM = SEEDED_LOCATION_IDS.shyamoli;
const CORNER = SEEDED_LOCATION_IDS.parlour;

type Tx = Prisma.TransactionClient;

async function scratchVariant(tx: Tx, stock: { locationId: string; qty: number }[], cost = 500) {
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow({ orderBy: { sortOrder: "asc" } }), tx.color.findFirstOrThrow({ orderBy: { sortOrder: "asc" } })]);
  const code = testProductCode();
  const product = await tx.product.create({ data: { code, name: `Shelf test ${code}`, basePrice: 1500 } });
  const v = await tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: testSku(code), weightedAvgCost: cost } });
  for (const s of stock) await recordStockMovement(tx, { variantId: v.id, locationId: s.locationId, type: "PURCHASE_IN", qty: s.qty, unitCost: cost, referenceType: "OPENING_BALANCE", actorId: null });
  return v;
}

/** Fresh shelves at a location (codes unique per test run). Returns code → id. */
async function shelves(tx: Tx, manager: SessionUser, locationId: string, codes: string[]) {
  await createShelves(tx, manager, { locationId, codes });
  const rows = await tx.shelf.findMany({ where: { locationId, code: { in: codes } }, select: { id: true, code: true } });
  return Object.fromEntries(rows.map((r) => [r.code, r.id])) as Record<string, string>;
}

/** Unique-per-run shelf codes: rack letters + 4 digits from the clock. */
let rackSeq = 0;
function rack() {
  rackSeq += 1;
  return `Z${String((Date.now() + rackSeq) % 1000).padStart(3, "0")}`;
}

/**
 * Where a variant is at a location — and proof the rules hold: stock =
 * ledger, no shelf below zero, shelves + not-on-shelf ≤ stock (checked as
 * a COMMIT would, by the database itself).
 */
async function where(tx: Tx, variantId: string, locationId: string) {
  await checkDeferredConstraintsNow(tx);
  const layer = await readShelfLayer(tx, variantId, locationId);
  for (const s of layer.shelves) expect(s.qty).toBeGreaterThanOrEqual(0);
  expect(layer.shelved + layer.missing, "shelves + not on its shelf ≤ location stock").toBeLessThanOrEqual(Math.max(0, layer.stock));
  const shelvesByCode = Object.fromEntries(layer.shelves.filter((s) => s.qty > 0).map((s) => [s.code.split("-").slice(1).join("-"), s.qty]));
  return { stock: layer.stock, unassigned: Math.max(0, layer.stock) - layer.shelved, notOnShelf: layer.missing, shelves: shelvesByCode };
}

async function confirmedOrder(tx: Tx, variantId: string, qty: number) {
  const customer = await tx.customer.findFirstOrThrow({ where: { deletedAt: null } });
  const order = await tx.order.create({
    data: { orderNo: `TEST-SHELF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, status: "CONFIRMED", customerId: customer.id, items: { create: [{ variantId, qty, unitPrice: 1000 }] } },
    include: { items: true },
  });
  await reserveVariantStock(tx, variantId, qty);
  return order;
}

async function sellAtShowroom(tx: Tx, pos: SessionUser, variantId: string) {
  const cashWallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
  await createPosSale(tx, { user: pos, cashWalletId: cashWallet.id, hasCostAccess: false, canCreateCustomer: true }, { items: [{ variantId, qty: 1, unitPrice: 1500, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CARD", amount: 1500 }] });
}

describe("shelves inside a location (CORRECTIONS.md item 20A)", () => {
  it(
    "shelves stay within the location's stock through put-away, moves, packing, POS sale, transfer out and in",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [packer, pos, manager] = await Promise.all([userFor(tx, PHONES.PACKING), userFor(tx, PHONES.POS), userFor(tx, PHONES.MANAGER)]);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1-1`, `${r}-1-2`, `${r}-2-1`]);
        const v = await scratchVariant(tx, [
          { locationId: HUB, qty: 6 },
          { locationId: SHOWROOM, qty: 4 },
        ]);
        // Arrived stock is Unassigned until put away.
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 6, unassigned: 6, notOnShelf: 0, shelves: {} });

        // PUT-AWAY: scan 3 dresses, then the shelf; then 2 onto another.
        await putAway(tx, packer, { locationId: HUB, toShelfId: s[`${r}-1-1`], items: [{ variantId: v.id, qty: 3 }] });
        await putAway(tx, packer, { locationId: HUB, toShelfId: s[`${r}-1-2`], items: [{ variantId: v.id, qty: 2 }] });
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 6, unassigned: 1, notOnShelf: 0, shelves: { "1-1": 3, "1-2": 2 } });

        // MOVE: scan the shelf it's on, the dress, then the new shelf.
        await putAway(tx, packer, { locationId: HUB, fromShelfId: s[`${r}-1-1`], toShelfId: s[`${r}-2-1`], items: [{ variantId: v.id, qty: 1 }] });
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 6, unassigned: 1, notOnShelf: 0, shelves: { "1-1": 2, "1-2": 2, "2-1": 1 } });
        // A move off a shelf that doesn't hold that many is refused.
        await expect(putAway(tx, packer, { locationId: HUB, fromShelfId: s[`${r}-2-1`], toShelfId: s[`${r}-1-1`], items: [{ variantId: v.id, qty: 2 }] })).rejects.toThrow(ShelfError);
        // More than the location has can never go on a shelf.
        await expect(putAway(tx, packer, { locationId: HUB, toShelfId: s[`${r}-1-2`], items: [{ variantId: v.id, qty: 5 }] })).rejects.toThrow(/system shows 6/);
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 6, unassigned: 1, notOnShelf: 0, shelves: { "1-1": 2, "1-2": 2, "2-1": 1 } });
        // Only the location's own people put away: the showroom's POS operator can't here.
        await expect(putAway(tx, pos, { locationId: HUB, toShelfId: s[`${r}-1-1`], items: [{ variantId: v.id, qty: 1 }] })).rejects.toThrow(ShelfError);
        // …and a Sales Executive can't at all.
        await expect(putAway(tx, await userFor(tx, PHONES.SE), { locationId: HUB, toShelfId: s[`${r}-1-1`], items: [{ variantId: v.id, qty: 1 }] })).rejects.toThrow(ShelfError);

        // PACKING 3 (no shelf known): Unassigned's 1 first, then the
        // fullest shelf — 1-1 and 1-2 tie at 2, shelf order picks 1-1.
        const order = await confirmedOrder(tx, v.id, 3);
        await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 3, unassigned: 0, notOnShelf: 0, shelves: { "1-2": 2, "2-1": 1 } });

        // TRANSFER OUT 2: one scanned off shelf 2-1 (its label scanned
        // first), one scanned alone → the fullest shelf, 1-2.
        const out = await createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: CORNER });
        const label = await scanTransferUnit(tx, packer, out.id, "send", `${r}-2-1`);
        expect(label.shelf?.id).toBe(s[`${r}-2-1`]);
        await scanTransferUnit(tx, packer, out.id, "send", v.sku, { shelfId: s[`${r}-2-1`] });
        // Shelf 2-1 had one — a second off it is refused.
        await expect(scanTransferUnit(tx, packer, out.id, "send", v.sku, { shelfId: s[`${r}-2-1`] })).rejects.toThrow(/shows 1/);
        await scanTransferUnit(tx, packer, out.id, "send", v.sku);
        // Nothing leaves a shelf until Send.
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 3, unassigned: 0, notOnShelf: 0, shelves: { "1-2": 2, "2-1": 1 } });
        await sendTransfer(tx, packer, out.id);
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 1, unassigned: 0, notOnShelf: 0, shelves: { "1-2": 1 } });
        // The parlour corner doesn't use shelves: nothing to put away there.
        expect((await shelfWhereabouts(tx, [v.id])).get(v.id)?.map((w) => w.locationId)).toEqual([HUB]);

        expect((await findStockLedgerDivergences(tx)).filter((d) => d.variantId === v.id)).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "shelves stay within the location's stock through transfer in and a POS sale",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [packer, pos, manager] = await Promise.all([userFor(tx, PHONES.PACKING), userFor(tx, PHONES.POS), userFor(tx, PHONES.MANAGER)]);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1-1`, `${r}-1-2`]);
        const v = await scratchVariant(tx, [
          { locationId: HUB, qty: 1 },
          { locationId: SHOWROOM, qty: 4 },
        ]);
        await putAway(tx, packer, { locationId: HUB, toShelfId: s[`${r}-1-2`], items: [{ variantId: v.id, qty: 1 }] });

        // TRANSFER IN 2 from the showroom: lands in the hub's Unassigned.
        const back = await createTransfer(tx, pos, { fromLocationId: SHOWROOM, toLocationId: HUB });
        await scanTransferUnit(tx, pos, back.id, "send", v.sku);
        await scanTransferUnit(tx, pos, back.id, "send", v.sku);
        await sendTransfer(tx, pos, back.id);
        await scanTransferUnit(tx, packer, back.id, "receive", v.sku);
        await scanTransferUnit(tx, packer, back.id, "receive", v.sku);
        await receiveTransfer(tx, packer, back.id);
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 3, unassigned: 2, notOnShelf: 0, shelves: { "1-2": 1 } });
        await putAway(tx, packer, { locationId: HUB, toShelfId: s[`${r}-1-1`], items: [{ variantId: v.id, qty: 2 }] });
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 3, unassigned: 0, notOnShelf: 0, shelves: { "1-1": 2, "1-2": 1 } });

        // POS SALE at a location using shelves (switched on just here):
        // Unassigned first, then the fullest shelf.
        await tx.location.update({ where: { id: SHOWROOM }, data: { usesShelves: true } });
        const sr = rack();
        const ss = await shelves(tx, manager, SHOWROOM, [`${sr}-1`]);
        await putAway(tx, pos, { locationId: SHOWROOM, toShelfId: ss[`${sr}-1`], items: [{ variantId: v.id, qty: 1 }] });
        expect(await where(tx, v.id, SHOWROOM)).toEqual({ stock: 2, unassigned: 1, notOnShelf: 0, shelves: { "1": 1 } });
        await sellAtShowroom(tx, pos, v.id);
        expect(await where(tx, v.id, SHOWROOM)).toEqual({ stock: 1, unassigned: 0, notOnShelf: 0, shelves: { "1": 1 } });
        await sellAtShowroom(tx, pos, v.id);
        expect(await where(tx, v.id, SHOWROOM)).toEqual({ stock: 0, unassigned: 0, notOnShelf: 0, shelves: {} });

        // The ledger never saw any of the shelf moves, and still matches.
        expect(await tx.shelfMovement.count({ where: { variantId: v.id } })).toBeGreaterThan(0);
        expect((await findStockLedgerDivergences(tx)).filter((d) => d.variantId === v.id)).toEqual([]);
        expect(await findShelfDivergences(tx)).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "a shelf count with a sale and a move in the middle finds no false difference, and never changes stock",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [packer, manager] = await Promise.all([userFor(tx, PHONES.PACKING), userFor(tx, PHONES.MANAGER)]);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1`, `${r}-2`]);
        const A = s[`${r}-1`];
        const B = s[`${r}-2`];
        // On shelf A: 3 × sold (scanned, then one sold), 2 × gone (sold
        // before anyone scanned it), 2 × moved (scanned, then one moved to
        // B), 2 × lost (nobody finds them), 1 × extra (+1 waiting in Unassigned).
        const sold = await scratchVariant(tx, [{ locationId: HUB, qty: 3 }]);
        const gone = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        const moved = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        const lost = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        const extra = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        for (const [v, qty] of [[sold, 3], [gone, 2], [moved, 2], [lost, 2], [extra, 1]] as const) {
          await putAway(tx, packer, { locationId: HUB, toShelfId: A, items: [{ variantId: v.id, qty }] });
        }
        const ours = { variantId: { in: [sold.id, gone.id, moved.id, lost.id, extra.id] } };
        const ledgerRowsBefore = await tx.stockMovement.count({ where: ours });

        const count = await startShelfCount(tx, packer, A);
        // Starting again joins the same count.
        expect((await startShelfCount(tx, packer, A)).id).toBe(count.id);
        await scanShelfCount(tx, packer, count.id, `${r}-1`);
        await expect(scanShelfCount(tx, packer, count.id, `${r}-2`)).rejects.toThrow(/this count is for/);
        for (let i = 0; i < 3; i++) await scanShelfCount(tx, packer, count.id, sold.sku);
        for (let i = 0; i < 2; i++) await scanShelfCount(tx, packer, count.id, moved.sku);
        for (let i = 0; i < 2; i++) await scanShelfCount(tx, packer, count.id, extra.sku);

        // In the middle of the count: a sale picked off A (packing), a sale
        // of an unscanned item, and a move from A to B.
        const o1 = await confirmedOrder(tx, sold.id, 1);
        await packOrder(tx, { id: o1.id, status: "CONFIRMED", items: o1.items }, packer.id);
        const o2 = await confirmedOrder(tx, gone.id, 1);
        await packOrder(tx, { id: o2.id, status: "CONFIRMED", items: o2.items }, packer.id);
        await putAway(tx, packer, { locationId: HUB, fromShelfId: A, toShelfId: B, items: [{ variantId: moved.id, qty: 1 }] });
        expect(await where(tx, sold.id, HUB)).toEqual({ stock: 2, unassigned: 0, notOnShelf: 0, shelves: { "1": 2 } });

        const view = await getShelfCountView(tx, packer, count.id);
        expect(view?.lines.find((l) => l.variantId === sold.id)).toMatchObject({ counted: 3, expected: 3, difference: 0 });
        expect(view?.lines.find((l) => l.variantId === gone.id)).toMatchObject({ scanned: false, movedDuringCount: true, difference: 0 });
        expect(view?.lines.find((l) => l.variantId === lost.id)).toMatchObject({ scanned: false, counted: 0, expected: 2, difference: -2 });

        const result = await finishShelfCount(tx, packer, count.id);
        expect(result).toEqual({ missing: 2, placed: 1, unplaced: 0, movedDuringCount: 1 });
        // Sold during the count: no false "missing" — A holds what's left.
        expect(await where(tx, sold.id, HUB)).toEqual({ stock: 2, unassigned: 0, notOnShelf: 0, shelves: { "1": 2 } });
        // Moved during the count: no false difference on either shelf.
        expect(await where(tx, moved.id, HUB)).toEqual({ stock: 2, unassigned: 0, notOnShelf: 0, shelves: { "1": 1, "2": 1 } });
        // Sold before anyone scanned it: left as it is.
        expect(await where(tx, gone.id, HUB)).toEqual({ stock: 1, unassigned: 0, notOnShelf: 0, shelves: { "1": 1 } });
        // Not found: off the shelf, "not on its shelf" — still in stock.
        expect(await where(tx, lost.id, HUB)).toEqual({ stock: 2, unassigned: 2, notOnShelf: 2, shelves: {} });
        // Found one more than A showed: brought from Unassigned.
        expect(await where(tx, extra.id, HUB)).toEqual({ stock: 2, unassigned: 0, notOnShelf: 0, shelves: { "1": 2 } });
        // A shelf count never touches stock: only the two packings wrote ledger rows.
        expect(await tx.stockMovement.count({ where: ours })).toBe(ledgerRowsBefore + 2);

        // The manager sees the not-on-its-shelf units.
        const page = await getShelfLocationView(tx, manager, HUB);
        expect(page.misses.filter((m) => m.item.variantId === lost.id).map((m) => [m.shelfCode, m.qty])).toEqual([[`${r}-1`, 2]]);

        // One turns up on shelf B: putting it away there finds it.
        await putAway(tx, packer, { locationId: HUB, toShelfId: B, items: [{ variantId: lost.id, qty: 1 }] });
        expect(await where(tx, lost.id, HUB)).toEqual({ stock: 2, unassigned: 1, notOnShelf: 1, shelves: { "2": 1 } });
        // The packer can't write off the other — that's a manager's call…
        const missId = (await tx.shelfMiss.findFirstOrThrow({ where: { variantId: lost.id, closedAt: null } })).id;
        await expect(writeOffMiss(tx, packer, missId, "Not found anywhere")).rejects.toThrow(ShelfError);
        // …who writes it off: it leaves the stock as a Stock shortage at cost.
        await writeOffMiss(tx, manager, missId, "Not found anywhere");
        expect(await where(tx, lost.id, HUB)).toEqual({ stock: 1, unassigned: 0, notOnShelf: 0, shelves: { "2": 1 } });
        const writeOff = await tx.stockMovement.findFirstOrThrow({ where: { variantId: lost.id, referenceId: missId }, include: { expense: true } });
        expect([writeOff.qty, writeOff.expense?.amount.toString()]).toEqual([-1, "500"]);
        expect(await findShelfDivergences(tx)).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "a location count settles units not on their shelf — a short count posts the expense, a full one just closes them",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [packer, manager] = await Promise.all([userFor(tx, PHONES.PACKING), userFor(tx, PHONES.MANAGER)]);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1`]);
        const v = await scratchVariant(tx, [{ locationId: HUB, qty: 3 }]);
        await putAway(tx, packer, { locationId: HUB, toShelfId: s[`${r}-1`], items: [{ variantId: v.id, qty: 3 }] });
        // The shelf count finds only 1: 2 go "not on its shelf".
        const sc = await startShelfCount(tx, packer, s[`${r}-1`]);
        await scanShelfCount(tx, packer, sc.id, v.sku);
        await finishShelfCount(tx, packer, sc.id);
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 3, unassigned: 2, notOnShelf: 2, shelves: { "1": 1 } });

        // The location count finds 2 in the building: 1 short (expense), and
        // the "not on its shelf" units are settled either way.
        const lc = await createStockCount(tx, packer, { locationId: HUB, scope: "SPOT" });
        await scanCountUnit(tx, packer, lc.id, v.sku);
        await scanCountUnit(tx, packer, lc.id, v.sku);
        await postStockCount(tx, manager, lc.id);
        expect(await where(tx, v.id, HUB)).toEqual({ stock: 2, unassigned: 1, notOnShelf: 0, shelves: { "1": 1 } });
        const closed = await tx.shelfMiss.findMany({ where: { variantId: v.id }, select: { qty: true, closeReason: true } });
        expect(closed).toEqual([{ qty: 0, closeReason: "LOCATION_COUNT" }]);
        const short = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: "STOCK_COUNT", referenceId: lc.id }, include: { expense: true } });
        expect([short.qty, short.expense?.amount.toString()]).toEqual([-1, "500"]);
      });
    },
    TIMEOUT,
  );

  it(
    "the database refuses shelves holding more than the location, or a shelf below zero",
    async () => {
      const tooMany = inRolledBackTransaction(async (tx) => {
        const manager = await userFor(tx, PHONES.MANAGER);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1`]);
        const v = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        // Straight past the engine: 3 on a shelf of a location holding 2.
        await tx.shelfStock.create({ data: { shelfId: s[`${r}-1`], locationId: HUB, variantId: v.id, qty: 3 } });
        await checkDeferredConstraintsNow(tx);
      });
      await expect(tooMany).rejects.toThrow(/shelves exceed location stock/);

      const stockLeavesShelves = inRolledBackTransaction(async (tx) => {
        const manager = await userFor(tx, PHONES.MANAGER);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1`]);
        const v = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        await tx.shelfStock.create({ data: { shelfId: s[`${r}-1`], locationId: HUB, variantId: v.id, qty: 2 } });
        // Stock leaving without taking the shelf down (a writer bypassing the ledger's shelf step).
        await tx.$executeRaw`UPDATE "variant_stocks" SET "qty" = 1 WHERE "variantId" = ${v.id} AND "locationId" = ${HUB}`;
        await checkDeferredConstraintsNow(tx);
      });
      await expect(stockLeavesShelves).rejects.toThrow(/shelves exceed location stock|stock\/ledger divergence/);

      const negative = inRolledBackTransaction(async (tx) => {
        const manager = await userFor(tx, PHONES.MANAGER);
        const r = rack();
        const s = await shelves(tx, manager, HUB, [`${r}-1`]);
        const v = await scratchVariant(tx, [{ locationId: HUB, qty: 2 }]);
        await tx.shelfStock.create({ data: { shelfId: s[`${r}-1`], locationId: HUB, variantId: v.id, qty: -1 } });
      });
      await expect(negative).rejects.toThrow(/shelf_stocks_qty_chk/);
    },
    TIMEOUT,
  );

  it(
    "a location that doesn't use shelves has no shelves",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const manager = await userFor(tx, PHONES.MANAGER);
        await expect(createShelves(tx, manager, { locationId: SHOWROOM, codes: ["A-1"] })).rejects.toThrow(/doesn't use shelves/);
        // A shelf code always has a hyphen — it can never read as a SKU.
        await expect(createShelves(tx, manager, { locationId: HUB, codes: ["A1"] })).rejects.toThrow(/hyphens/);
      });
    },
    TIMEOUT,
  );
});
