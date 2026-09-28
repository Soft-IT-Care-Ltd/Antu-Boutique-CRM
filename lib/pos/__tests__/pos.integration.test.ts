import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers call auth(); next-auth can't load under plain Node, so the
// session is whatever the test says it is.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { GET as orderGET } from "@/app/api/orders/[id]/route";
import { GET as ordersGET } from "@/app/api/orders/route";
import { GET as tagPurchasesGET } from "@/app/api/catalog/price-tags/purchases/route";
import { GET as drawerGET, POST as drawerPOST } from "@/app/api/pos/drawer/route";
import { GET as drawerHistoryGET } from "@/app/api/pos/drawer/history/route";
import { GET as lookupGET } from "@/app/api/pos/lookup/route";
import { GET as salesGET } from "@/app/api/pos/sales/route";
import { GET as searchGET } from "@/app/api/pos/search/route";
import { decodeCode128Widths } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { findLabelStock } from "@/lib/catalog/price-tag-layout";
import { expandTags, PriceTagError, tagsForPurchase } from "@/lib/catalog/price-tags";
import { sessionUserFor, uniquePhone } from "@/lib/courier/__tests__/helpers";
import { getDayAllocation } from "@/lib/expenses/ad-allocation";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { findStockLedgerDivergences, recordStockMovement } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { toNumber } from "@/lib/money";
import { CASH_OVER_SHORT_CATEGORY_ID } from "@/lib/pos/constants";
import { closeDrawer, DrawerError, getDrawerSummary, openDrawer, recordDrawerMovement } from "@/lib/pos/drawer";
import { findVariantByCode } from "@/lib/pos/lookup";
import { loadReceiptOrder, renderReceiptHtml } from "@/lib/pos/receipt";
import { createPosSale, NegativeStockConfirmError, PosSaleError, type PosContext } from "@/lib/pos/sale";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";
import { getWalletBalances } from "@/lib/wallets/ledger";

// P3.1 — POS / walk-in sales and the cash drawer (PRD §4.7). Service tests
// run in a rolled-back transaction on antu_test; route tests read the
// seeded demo (prisma/seed.ts seedPosDemo) and never write.

beforeEach(() => {
  session.current = null;
});

const ADMIN = "01711000001";
const MANAGER = "01711000002";
const SE = "01711000004";
const PACKING = "01711000005";
const ACCOUNTS = "01711000006";
const POS = "01711000007";

const COST_KEYS = ["weightedAvgCost", "unitCostSnapshot", "cost", "costPrice", "unitCost", "purchasePrice", "profit", "margin", "valueAtCost", "landedUnitCost", "lineCost"];

function costKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => costKeysIn(v, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (COST_KEYS.includes(k)) found.push(k);
      costKeysIn(v, found);
    }
  }
  return found;
}

async function signInAs(phone: string) {
  const user = await sessionUserFor(phone);
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
  return user;
}

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function freshVariant(tx: Prisma.TransactionClient, opts: { stock?: number; wac?: number; price?: number; sku?: string } = {}) {
  const size = await tx.size.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
  const color = await tx.color.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
  const code = testProductCode();
  const product = await tx.product.create({ data: { code, name: `POS test ${code}`, basePrice: opts.price ?? 1000 } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: opts.sku ?? testSku(code), weightedAvgCost: opts.wac ?? 400 } });
  if ((opts.stock ?? 10) > 0) {
    // C3 — the POS sells from the Shyamoli showroom's stock.
    await recordStockMovement(tx, { variantId: variant.id, locationId: SEEDED_LOCATION_IDS.shyamoli, type: "PURCHASE_IN", qty: opts.stock ?? 10, unitCost: opts.wac ?? 400, referenceType: "OPENING_BALANCE", actorId: null });
  }
  return variant;
}

/** A test-only drawer wallet, so the seeded Showroom Cash drawer isn't touched. */
async function freshCashWallet(tx: Prisma.TransactionClient, opening = 2000) {
  return tx.wallet.create({ data: { name: `Test drawer ${uniquePhone()}`, type: "CASH", openingBalance: opening, openingDate: dhakaDayStartUtc("2026-01-01"), sortOrder: 0 } });
}

const balance = async (tx: Prisma.TransactionClient, walletId: string) => toNumber((await getWalletBalances(tx, { walletId }))[0].balance);

async function posContext(walletId: string, phone = POS, extra: Partial<PosContext> = {}): Promise<PosContext> {
  return { user: await sessionUserFor(phone), cashWalletId: walletId, hasCostAccess: false, canCreateCustomer: true, ...extra };
}

describe("a showroom day: open, sell, cash out, count and close", () => {
  it("moves stock, money, wallets and the drawer exactly once, and posts a shortage", async () => {
    await inRolledBackTransaction(async (tx) => {
      const cash = await freshCashWallet(tx, 2000);
      const bank = await tx.wallet.create({ data: { name: `Test bank ${uniquePhone()}`, type: "BANK", openingBalance: 0, openingDate: dhakaDayStartUtc("2026-01-01") } });
      const variant = await freshVariant(tx, { stock: 10, wac: 400, price: 1000 });
      const ctx = await posContext(cash.id);

      // Cash needs the drawer open.
      await expect(
        createPosSale(tx, ctx, { items: [{ variantId: variant.id, qty: 1, unitPrice: 1000, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CASH", amount: 1000 }] }),
      ).rejects.toThrow(DrawerError);

      await openDrawer(tx, ctx.user, cash.id, { openingCount: 2000, denominations: { "1000": 1, "500": 2 } });

      // Two pieces, ৳100 off the lot, part cash (with change) part bKash.
      const sale = await createPosSale(tx, ctx, {
        items: [{ variantId: variant.id, qty: 2, unitPrice: 1000, lineDiscount: 0 }],
        cartDiscount: 100,
        customer: null,
        tenders: [
          { method: "CASH", amount: 1400, tendered: 1500 },
          { method: "BKASH", amount: 500, transactionId: `POSTEST${uniquePhone()}` },
        ],
      });
      expect(sale).toMatchObject({ total: "1900.00", change: "100.00", customerName: null });

      const order = await tx.order.findUniqueOrThrow({ where: { id: sale.orderId }, include: { items: true, payments: true, shipment: true, statusHistory: true } });
      expect(order).toMatchObject({ channel: "WALK_IN", status: "COMPLETED", customerId: null, courierId: null, courierZoneId: null, shipment: null });
      expect(toNumber(order.total)).toBe(1900);
      expect(toNumber(order.discountTotal)).toBe(100);
      expect(toNumber(order.dueAmount)).toBe(0);
      // Cost frozen at the sale, at the cost the ledger row carries.
      expect(order.items).toHaveLength(1);
      expect(toNumber(order.items[0].unitCostSnapshot!)).toBe(400);
      expect(toNumber(order.items[0].lineDiscount)).toBe(100);
      // Straight to COMPLETED: never CONFIRMED, so never reserved.
      expect(order.statusHistory.map((h) => [h.fromStatus, h.toStatus])).toEqual([[null, "COMPLETED"]]);

      const v = await tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      expect(v).toMatchObject({ stockQty: 8, reservedQty: 0 });
      const movement = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: order.id } });
      expect(movement).toMatchObject({ type: "POS_SALE_OUT", qty: -2, stockAfter: 8, referenceType: "ORDER" });
      expect(toNumber(movement.unitCostSnapshot)).toBe(400);

      const cashPayment = order.payments.find((p) => p.method === "CASH")!;
      expect(cashPayment).toMatchObject({ walletId: cash.id, verified: false });
      expect(toNumber(cashPayment.cashTendered!)).toBe(1500);
      expect(cashPayment.note).toContain("change ৳ 100");
      expect(order.payments.find((p) => p.method === "BKASH")!.walletId).not.toBeNull();
      expect(await tx.auditLog.count({ where: { action: "pos.sale", entityId: order.id } })).toBe(1);

      // The 80 mm receipt: what was bought, the discount, how it was paid, the change — never cost.
      const receipt = renderReceiptHtml((await loadReceiptOrder(tx, order.id))!, "");
      for (const text of [order.orderNo, "Walk-in customer", variant.sku, "− ৳ 100", "৳ 1,900", "bKash", "Cash given", "৳ 1,500", "Change", "৳ 100", "ধন্যবাদ", "Thank you"]) {
        expect(receipt).toContain(text);
      }
      expect(receipt).not.toContain("৳ 400"); // the unit cost

      // Walk-in sales never carry allocated ad cost.
      const allocation = await getDayAllocation(tx, todayInDhaka());
      expect(allocation.orders.map((o) => o.id)).not.toContain(order.id);

      // Cash taken for an online order at the counter is drawer cash too.
      const onlineOrder = await tx.order.findFirstOrThrow({ where: { channel: "ONLINE", deletedAt: null } });
      await tx.payment.create({ data: { orderId: onlineOrder.id, amount: 300, method: "CASH", walletId: cash.id, receivedById: ctx.user.id } });

      const drawer = (await tx.cashDrawer.findFirstOrThrow({ where: { walletId: cash.id } })).id;
      let summary = (await getDrawerSummary(tx, drawer))!;
      expect(summary.totals).toMatchObject({ cashSales: "1400.00", cashSalesCount: 1, otherCashIn: "300.00", cashOut: "0.00", unverified: "1700.00", unverifiedCount: 2 });
      expect(summary.expectedClose).toBe("3700.00");

      // Cash out: a petty expense and a bank deposit, through the normal services.
      await recordDrawerMovement(tx, ctx.user, cash.id, { kind: "EXPENSE", amount: 150, categoryId: "expcat_misc", note: "Tea for customers" });
      await recordDrawerMovement(tx, ctx.user, cash.id, { kind: "DEPOSIT", amount: 1000, toWalletId: bank.id, note: "Evening bank deposit" });
      await expect(recordDrawerMovement(tx, ctx.user, cash.id, { kind: "CASH_OUT", amount: 9000, note: "More than is there" })).rejects.toThrow(DrawerError);
      summary = (await getDrawerSummary(tx, drawer))!;
      expect(summary.expectedClose).toBe("2550.00");
      expect(summary.totals.cashOut).toBe("1150.00");

      // Before the count, the wallet only holds verified money.
      expect(await balance(tx, cash.id)).toBe(2000 - 150 - 1000);

      // Counted ৳50 short: a note is required, then it's posted once.
      await expect(closeDrawer(tx, ctx.user, { drawerId: drawer, closingCount: 2500 })).rejects.toThrow(/short/);
      summary = await closeDrawer(tx, ctx.user, { drawerId: drawer, closingCount: 2500, note: "Gave ৳50 too much change" });
      expect(summary).toMatchObject({ status: "CLOSED", expectedClose: "2550.00", closingCount: "2500.00", difference: "-50.00" });
      const shortage = await tx.expense.findFirstOrThrow({ where: { cashDrawerId: drawer } });
      expect(shortage).toMatchObject({ categoryId: CASH_OVER_SHORT_CATEGORY_ID, walletId: cash.id });
      expect(toNumber(shortage.amount)).toBe(50);

      // The count verified the day's cash; the wallet now equals the counted cash.
      const verified = await tx.payment.findMany({ where: { walletId: cash.id, kind: "PAYMENT" } });
      expect(verified.every((p) => p.verified && p.verifiedById === ctx.user.id)).toBe(true);
      expect(await tx.auditLog.count({ where: { action: "payment.verify", after: { path: ["via"], equals: "cash_drawer_close" } } })).toBeGreaterThanOrEqual(2);
      expect(await balance(tx, cash.id)).toBe(2500);
      expect(await tx.auditLog.count({ where: { action: "pos.drawer.close", entityId: drawer } })).toBe(1);

      // A closed drawer takes no more cash, can't close twice; card still sells.
      await expect(closeDrawer(tx, ctx.user, { drawerId: drawer, closingCount: 2500 })).rejects.toThrow(DrawerError);
      await expect(
        createPosSale(tx, ctx, { items: [{ variantId: variant.id, qty: 1, unitPrice: 1000, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CASH", amount: 1000 }] }),
      ).rejects.toThrow(/closed/);
      await createPosSale(tx, ctx, { items: [{ variantId: variant.id, qty: 1, unitPrice: 1000, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CARD", amount: 1000 }] });
      await expect(openDrawer(tx, ctx.user, cash.id, { openingCount: 2500 })).rejects.toThrow(/already been counted/);

      // A card sale after close is not drawer cash: the frozen figures hold.
      summary = (await getDrawerSummary(tx, drawer))!;
      expect(summary.expectedClose).toBe("2550.00");

      await checkDeferredConstraintsNow(tx);
      expect(await findStockLedgerDivergences(tx)).toEqual([]);
    });
  }, 120_000);

  it("posts an overage as a credit, and asks why an opening count differs from the last close", async () => {
    await inRolledBackTransaction(async (tx) => {
      const cash = await freshCashWallet(tx, 0);
      const variant = await freshVariant(tx, { price: 500 });
      const ctx = await posContext(cash.id);
      const opened = await openDrawer(tx, ctx.user, cash.id, { openingCount: 0 });
      await createPosSale(tx, ctx, { items: [{ variantId: variant.id, qty: 1, unitPrice: 500, lineDiscount: 0 }], cartDiscount: 0, tenders: [{ method: "CASH", amount: 500 }] });
      const closed = await closeDrawer(tx, ctx.user, { drawerId: opened.id, closingCount: 520, note: "Customer left ৳20 change" });
      expect(closed.difference).toBe("20.00");
      const credit = await tx.expense.findFirstOrThrow({ where: { cashDrawerId: opened.id } });
      expect(toNumber(credit.amount)).toBe(-20);
      expect(await balance(tx, cash.id)).toBe(520);

      // Next day: an opening count that doesn't match the last close needs a note.
      await tx.cashDrawer.update({ where: { id: opened.id }, data: { businessDay: dhakaDayStartUtc(todayInDhaka(), -1) } });
      await expect(openDrawer(tx, ctx.user, cash.id, { openingCount: 600 })).rejects.toThrow(/differs from the last close/);
      const today = await openDrawer(tx, ctx.user, cash.id, { openingCount: 600, note: "Owner added ৳80 change" });
      expect(today.openingNote).toBe("Owner added ৳80 change");
    });
  }, 120_000);
});

describe("POS sale guards", () => {
  it("refuses short payment, overpayment, price below cost, and selling past available stock", async () => {
    await inRolledBackTransaction(async (tx) => {
      const cash = await freshCashWallet(tx);
      const variant = await freshVariant(tx, { stock: 3, wac: 400, price: 1000 });
      const ctx = await posContext(cash.id);
      await openDrawer(tx, ctx.user, cash.id, { openingCount: 2000 });
      const line = { variantId: variant.id, qty: 1, unitPrice: 1000, lineDiscount: 0 };

      await expect(createPosSale(tx, ctx, { items: [line], cartDiscount: 0, tenders: [{ method: "CARD", amount: 900 }] })).rejects.toThrow(/still to pay/);
      await expect(createPosSale(tx, ctx, { items: [line], cartDiscount: 0, tenders: [{ method: "CARD", amount: 1100 }] })).rejects.toThrow(/more than the total/);
      await expect(createPosSale(tx, ctx, { items: [line], cartDiscount: 0, tenders: [{ method: "CASH", amount: 1000, tendered: 900 }] })).rejects.toThrow(PosSaleError);
      // POS operator can't see cost, so can't unknowingly sell below it.
      await expect(createPosSale(tx, ctx, { items: [{ ...line, unitPrice: 350 }], cartDiscount: 0, tenders: [{ method: "CARD", amount: 350 }] })).rejects.toThrow(/below the minimum/);

      // C3 (CORRECTIONS.md item 11): more than the showroom shows is sold
      // only once the operator confirms the item is in hand…
      const thin = await freshVariant(tx, { stock: 1, wac: 400, price: 1000 });
      const thinSale = { items: [{ ...line, variantId: thin.id, qty: 2 }], cartDiscount: 0, tenders: [{ method: "CARD" as const, amount: 2000 }] };
      await expect(createPosSale(tx, ctx, thinSale)).rejects.toBeInstanceOf(NegativeStockConfirmError);
      // …then the showroom goes negative, the line says so, and the people
      // who manage Shyamoli (its incharge, and Admin/Manager) are alerted.
      const sale = await createPosSale(tx, ctx, { ...thinSale, acknowledgeNegativeStock: true });
      const item = await tx.orderItem.findFirstOrThrow({ where: { orderId: sale.orderId } });
      expect(item.stockOverride).toBe(true);
      expect(item.stockOverrideReason).toMatch(/went negative/);
      expect((await tx.variantStock.findUniqueOrThrow({ where: { variantId_locationId: { variantId: thin.id, locationId: SEEDED_LOCATION_IDS.shyamoli } } })).qty).toBe(-1);
      const alerted = await tx.notification.findMany({ where: { kind: "NEGATIVE_STOCK", dedupeKey: { contains: thin.id } }, select: { user: { select: { phone: true } } } });
      expect(alerted.map((n) => n.user.phone)).toEqual(expect.arrayContaining([POS, MANAGER]));
      expect(await findStockLedgerDivergences(tx)).toEqual([]);

      // A reused TrxID is refused by the database (CLAUDE.md rule 4).
      // (That sale took the last pieces — the next one needs fresh stock.)
      const fresh = await freshVariant(tx, { stock: 5, wac: 400, price: 1000 });
      const trx = `DUP${uniquePhone()}`;
      await createPosSale(tx, ctx, { items: [{ ...line, variantId: fresh.id }], cartDiscount: 0, tenders: [{ method: "BKASH", amount: 1000, transactionId: trx }] });
      await expect(tx.payment.create({ data: { orderId: sale.orderId, amount: 1, method: "BKASH", transactionId: trx } })).rejects.toThrow();
    });
  }, 120_000);

  it("links a phone to the customer record — new, returning, or another executive's — without exposing or renaming it", async () => {
    await inRolledBackTransaction(async (tx) => {
      const cash = await freshCashWallet(tx);
      const variant = await freshVariant(tx);
      const ctx = await posContext(cash.id);
      const buy = (customer: { phone: string; name?: string } | null) =>
        createPosSale(tx, ctx, { items: [{ variantId: variant.id, qty: 1, unitPrice: 1000, lineDiscount: 0 }], cartDiscount: 0, customer, tenders: [{ method: "CARD", amount: 1000 }] });

      const phone = uniquePhone();
      const first = await buy({ phone, name: "Rina Akter" });
      const again = await buy({ phone, name: "Someone else" });
      const [o1, o2] = await Promise.all([tx.order.findUniqueOrThrow({ where: { id: first.orderId } }), tx.order.findUniqueOrThrow({ where: { id: again.orderId } })]);
      expect(o1.customerId).not.toBeNull();
      expect(o2.customerId).toBe(o1.customerId);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: o1.customerId! } })).name).toBe("Rina Akter");

      const seCustomer = await tx.customer.findFirstOrThrow({ where: { createdBy: { phone: SE }, deletedAt: null } });
      const linked = await buy({ phone: seCustomer.phone, name: "Renamed" });
      expect((await tx.order.findUniqueOrThrow({ where: { id: linked.orderId } })).customerId).toBe(seCustomer.id);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: seCustomer.id } })).name).toBe(seCustomer.name);

      await expect(buy({ phone: "12345" })).rejects.toThrow(/valid Bangladeshi phone/);
    });
  }, 120_000);
});

describe("price tags ↔ POS scan", () => {
  it("every seeded variant's tag barcode scans back to that variant, even with Caps Lock on", async () => {
    await inRolledBackTransaction(async (tx) => {
      // Packaging material (P3.3) is never sold — the scan leaves it out on purpose.
      const variants = await tx.productVariant.findMany({ where: { isActive: true, product: { deletedAt: null, isActive: true, kind: "SELLABLE" } }, select: { id: true, sku: true } });
      expect(variants.length).toBeGreaterThan(0);
      for (const v of variants) {
        const scanned = decodeCode128Widths(code128Widths(v.sku));
        expect((await findVariantByCode(tx, `${scanned}\r\n`, SEEDED_LOCATION_IDS.shyamoli))?.variantId).toBe(v.id);
        expect((await findVariantByCode(tx, scanned.toLowerCase(), SEEDED_LOCATION_IDS.shyamoli))?.variantId).toBe(v.id);
      }
      expect(await findVariantByCode(tx, "PRD-NOPE-XX", SEEDED_LOCATION_IDS.shyamoli)).toBeNull();
    });
  }, 120_000);

  it("prints one tag per piece received, carries no cost, and refuses SKUs a barcode can't carry", async () => {
    await inRolledBackTransaction(async (tx) => {
      const purchase = await tx.purchase.findFirstOrThrow({ include: { items: true } });
      const items = (await tagsForPurchase(tx, purchase.id))!;
      const received = new Map<string, number>();
      for (const i of purchase.items) received.set(i.variantId, (received.get(i.variantId) ?? 0) + i.qty);
      expect(new Map(items.map((i) => [i.variantId, i.suggestedCopies]))).toEqual(received);
      expect(costKeysIn(items)).toEqual([]);

      const roll = findLabelStock("roll-50x25")!;
      const tags = await expandTags(tx, { items: items.map((i) => ({ variantId: i.variantId, copies: 2 })), stock: roll, dpi: 203, startAt: 1 });
      expect(tags).toHaveLength(items.length * 2);

      // Every SKU fits the smallest label now (≤ 9 characters, DB CHECK), so
      // nothing tagged can be refused for length; a vanished variant still is.
      await expect(expandTags(tx, { items: [{ variantId: "cmissingvariant000000000", copies: 1 }], stock: roll, dpi: 203, startAt: 1 })).rejects.toThrow(PriceTagError);
      const smallest = findLabelStock("roll-38x25")!;
      expect(await expandTags(tx, { items: items.map((i) => ({ variantId: i.variantId, copies: 1 })), stock: smallest, dpi: 203, startAt: 1 })).toHaveLength(items.length);
    });
  }, 120_000);
});

describe("POS routes: who sees what (seeded demo, read-only)", () => {
  it("a POS operator sees selling prices and their own sales — never cost", async () => {
    const pos = await signInAs(POS);
    const search = await (await searchGET(req("/api/pos/search?q=kurti"))).json();
    expect(search.variants.length).toBeGreaterThan(0);
    expect(costKeysIn(search)).toEqual([]);

    const sku = search.variants[0].sku as string;
    const lookup = await (await lookupGET(req(`/api/pos/lookup?code=${encodeURIComponent(sku.toLowerCase())}`))).json();
    expect(lookup.variant.sku).toBe(sku);
    expect(costKeysIn(lookup)).toEqual([]);

    const sales = await (await salesGET()).json();
    const walkIns = await (await ordersGET(req("/api/orders?channel=WALK_IN&pageSize=100"))).json();
    expect(walkIns.items.length).toBeGreaterThan(0);
    expect(walkIns.items.every((o: { channel: string; createdBy: { id: string } }) => o.channel === "WALK_IN" && o.createdBy.id === pos.id)).toBe(true);
    expect(sales.sales.every((s: { id: string }) => walkIns.items.some((o: { id: string }) => o.id === s.id))).toBe(true);

    const detail = await (await orderGET(req(`/api/orders/${walkIns.items[0].id}`), { params: Promise.resolve({ id: walkIns.items[0].id }) })).json();
    expect(detail.order.channel).toBe("WALK_IN");
    expect(costKeysIn(detail)).toEqual([]);

    // The drawer: the operator reads it; nothing in it is cost.
    const drawer = await (await drawerGET()).json();
    expect(drawer.state.walletId).toBe("wallet_showroom_cash");
    expect(costKeysIn(drawer)).toEqual([]);
  }, 120_000);

  it("an Admin sees the frozen cost on a walk-in sale", async () => {
    await signInAs(ADMIN);
    const walkIns = await (await ordersGET(req("/api/orders?channel=WALK_IN&pageSize=5"))).json();
    const detail = await (await orderGET(req(`/api/orders/${walkIns.items[0].id}`), { params: Promise.resolve({ id: walkIns.items[0].id }) })).json();
    expect(detail.order.items[0].unitCostSnapshot).not.toBeNull();
  }, 60_000);

  it("Sales and Packing can't reach the POS; Accounts can read the drawer but not run it", async () => {
    for (const phone of [SE, PACKING]) {
      await signInAs(phone);
      expect((await salesGET()).status).toBe(403);
      expect((await searchGET(req("/api/pos/search?q=kurti"))).status).toBe(403);
      expect((await drawerGET()).status).toBe(403);
      expect((await tagPurchasesGET()).status).toBe(403);
    }
    await signInAs(SE);
    const seWalkIns = await (await ordersGET(req("/api/orders?channel=WALK_IN"))).json();
    expect(seWalkIns.total).toBe(0);

    await signInAs(ACCOUNTS);
    expect((await drawerGET()).status).toBe(200);
    expect((await drawerHistoryGET(req("/api/pos/drawer/history"))).status).toBe(200);
    expect((await drawerPOST(post("/api/pos/drawer", { openingCount: 100 }))).status).toBe(403);
    expect((await salesGET()).status).toBe(403);
  }, 120_000);
});
