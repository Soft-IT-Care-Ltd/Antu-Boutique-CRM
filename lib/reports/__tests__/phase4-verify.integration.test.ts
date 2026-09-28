import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));
vi.mock("@/lib/courier/steadfast/client");

import { GET as codGET } from "@/app/api/courier/cod/route";
import { GET as expensesGET } from "@/app/api/expenses/route";
import { GET as lowStockGET } from "@/app/api/inventory/low-stock/route";
import { GET as leadsGET } from "@/app/api/leads/route";
import { GET as ordersGET } from "@/app/api/orders/route";
import { GET as paymentsGET } from "@/app/api/payments/route";
import { GET as collectionGET } from "@/app/api/reports/collection/route";
import { GET as reportGET } from "@/app/api/reports/[report]/route";
import type { SessionUser } from "@/lib/auth/types";
import { makePackedOrder, sessionUserFor } from "@/lib/courier/__tests__/helpers";
import { COD_OVERDUE_DAYS, getAccountsNumbers, getLowStockSummary } from "@/lib/dashboard/operations";
import { codHref, collectionHref, expensesHref, followUpsHref, ordersHref } from "@/lib/dashboard/links";
import { getOwnerNumbers } from "@/lib/dashboard/owner";
import { getPendingApprovals, getSalesNumbers } from "@/lib/dashboard/sales";
import { createAdSpend } from "@/lib/expenses/service";
import { OPERATING_EXPENSE_FILTER } from "@/lib/expenses/constants";
import { getProfitReport } from "@/lib/finance/profit";
import { adjustStock, writeOffDamagedStock } from "@/lib/inventory/adjustments";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { toPaisa } from "@/lib/inventory/costing";
import { listDueFollowUps } from "@/lib/leads/queries";
import { recordStockMovement } from "@/lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { orderNumberYearMonth } from "@/lib/orders/constants";
import { prisma } from "@/lib/prisma";
import { REPORT_BY_KEY, type ReportKey } from "@/lib/reports/catalog";
import { parseReportFilters } from "@/lib/reports/filters";
import { runReport } from "@/lib/reports/run";
import type { ReportResult } from "@/lib/reports/types";
import { listReturnCases } from "@/lib/returns/queries";
import { deriveStoreCredit } from "@/lib/store-credit/balance";
import { adjustStoreCredit } from "@/lib/store-credit/ledger";
import { getLeaderboard } from "@/lib/targets/service";
import { statsByUser } from "@/lib/targets/performance";
import { dhakaDayStart, dhakaMonth, dhakaToday, monthRange, shiftMonth } from "@/lib/targets/month";
import { PHONES, runReturnWithDamage, userFor } from "@/lib/test/returns-fixtures";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// Verify Phase 4 (BUILD_PROMPTS.md, plus the owner's checks 5–10):
//   5. the P&L rule — every source reaches P&L exactly once, through
//      expenses; supplier payments never; per-order profit never — proven
//      by recomputing each month's net from the raw rows in plain SQL;
//   6. store credit — issuing isn't revenue, spending is, expiry and Admin
//      adjustments follow the §4.12 rule;
//   7. Dhaka day and month boundaries on every dashboard, report and target;
//   8. every dashboard number is the total of the list it opens;
//   9. the Online / Walk-in split adds up, on the dashboard and in R14;
//  10. a cancelled or returned order stops counting towards targets and the leaderboard.
// Reads the seeded demo data; every write runs in a rolled-back transaction.

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}

beforeEach(() => {
  session.current = null;
});

const DHAKA_OFFSET_MS = 6 * 3_600_000;
/** A Dhaka wall-clock moment ("2026-09-01", "00:30") as a UTC instant. */
const dhakaAt = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00Z`) - DHAKA_OFFSET_MS);
const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function reportFor(db: Prisma.TransactionClient | typeof prisma, user: SessionUser, key: ReportKey, query: Record<string, string>, now = new Date()): Promise<ReportResult> {
  const parsed = parseReportFilters(REPORT_BY_KEY[key], query);
  if (!parsed.ok) throw new Error(parsed.error);
  return runReport(db, user, key, parsed.filters, now);
}
const fig = (r: ReportResult, label: string) => r.figures.find((f) => f.label === label)?.value;
const paisaOf = (v: unknown) => toPaisa(String(v ?? 0));

async function getJson(handler: (req: NextRequest) => Promise<Response>, url: string) {
  const res = await handler(new NextRequest(`http://localhost${url}`));
  expect(res.status, url).toBe(200);
  return res.json();
}

// ---------------------------------------------------------------------------
// 5. The P&L rule
// ---------------------------------------------------------------------------

type PlLine = { revenue: number; cogs: number; opex: number; other: number; net: number };

async function plFor(db: Prisma.TransactionClient | typeof prisma, admin: SessionUser, fromDay: string, toDay: string): Promise<PlLine> {
  const r = await reportFor(db, admin, "pl", { from: fromDay, to: toDay });
  const t = r.tables.find((x) => x.id === "month-on-month")!.totals!;
  return { revenue: paisaOf(t.revenue), cogs: paisaOf(t.cogs), opex: paisaOf(t.opex), other: paisaOf(t.other), net: paisaOf(t.net) };
}

/**
 * The same P&L, worked out from the raw rows in plain SQL — not through
 * lib/finance/profit.ts. Days are cut by Postgres in Asia/Dhaka, not by
 * the app's UTC instants, so a boundary slip on either side shows.
 */
async function independentPl(db: Prisma.TransactionClient | typeof prisma, fromDay: string, toDay: string): Promise<PlLine> {
  const from = new Date(`${fromDay}T00:00:00Z`);
  const to = new Date(`${toDay}T00:00:00Z`);
  const [sales] = await db.$queryRaw<{ revenue: Prisma.Decimal | null; cogs: Prisma.Decimal | null }[]>`
    WITH out AS (
      SELECT o."id", o."total",
             COALESCE(
               (SELECT MIN(h."createdAt") FROM "order_status_history" h WHERE h."orderId" = o."id" AND h."toStatus" = 'PACKED'),
               CASE WHEN o."channel" = 'WALK_IN' THEN o."createdAt" END
             ) AS out_at
        FROM "orders" o
       WHERE o."deletedAt" IS NULL
         AND o."status"::text NOT IN ('LEAD', 'CANCELLED', 'RETURNED', 'REFUNDED')
    )
    SELECT SUM(out."total") AS revenue,
           SUM((SELECT SUM((i."qty" - i."returnedQty") * COALESCE(i."unitCostSnapshot", 0)) FROM "order_items" i WHERE i."orderId" = out."id")) AS cogs
      FROM out
     WHERE ((out.out_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date BETWEEN ${from}::date AND ${to}::date`;
  const [exp] = await db.$queryRaw<{ opex: Prisma.Decimal | null }[]>`
    SELECT SUM(e."amount") AS opex
      FROM "expenses" e JOIN "expense_categories" c ON c."id" = e."categoryId"
     WHERE e."deletedAt" IS NULL AND c."kind"::text <> 'PURCHASE'
       AND ((e."expenseDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date BETWEEN ${from}::date AND ${to}::date`;
  const [adj] = await db.$queryRaw<{ adjusted: Prisma.Decimal | null }[]>`
    SELECT SUM("amount") AS adjusted FROM "store_credit_entries"
     WHERE "type" = 'ADJUSTED'
       AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date BETWEEN ${from}::date AND ${to}::date`;
  // Expiry is derived, never stored (PRD §4.11): walk each customer's ledger.
  const rows = await db.storeCreditEntry.findMany({ select: { id: true, customerId: true, amount: true, createdAt: true, expiresAt: true } });
  const byCustomer = new Map<string, { id: string; amountPaisa: number; createdAt: Date; expiresAt: Date | null }[]>();
  for (const r of rows) byCustomer.set(r.customerId, [...(byCustomer.get(r.customerId) ?? []), { id: r.id, amountPaisa: toPaisa(r.amount), createdAt: r.createdAt, expiresAt: r.expiresAt }]);
  const end = new Date(dhakaDayStart(toDay, 1).getTime() - 1);
  let expired = 0;
  for (const list of byCustomer.values()) {
    for (const e of deriveStoreCredit(list, end).expiries) if (dhakaToday(e.at) >= fromDay && dhakaToday(e.at) <= toDay) expired += e.paisa;
  }
  const revenue = toPaisa(sales.revenue ?? 0);
  const cogs = toPaisa(sales.cogs ?? 0);
  const opex = toPaisa(exp.opex ?? 0);
  const other = expired - toPaisa(adj.adjusted ?? 0);
  return { revenue, cogs, opex, other, net: revenue - cogs - opex + other };
}

describe("5. the P&L rule (PRD §4.12)", () => {
  it("every month of seeded activity: the P&L equals its net recomputed from the raw rows", async () => {
    const admin = await sessionUserFor(PHONES.ADMIN);
    const today = todayInDhaka();
    const month = today.slice(0, 7);
    // Every month the seed has touched, up to the report's two-year limit.
    const kindsSeen = new Set<string>();
    let monthsChecked = 0;
    for (let m = shiftMonth(month, -23); m <= month; m = shiftMonth(m, 1)) {
      const fromDay = `${m}-01`;
      const toDay = m === month ? today : shiftDay(`${shiftMonth(m, 1)}-01`, -1);
      const [pl, raw] = await Promise.all([plFor(prisma, admin, fromDay, toDay), independentPl(prisma, fromDay, toDay)]);
      expect(pl, m).toEqual(raw);
      if (raw.revenue !== 0 || raw.opex !== 0) monthsChecked += 1;
      const r = monthRange(m);
      const kinds = await prisma.expense.groupBy({ by: ["categoryId"], where: { deletedAt: null, expenseDate: { gte: r.from, lt: r.to } } });
      const cats = await prisma.expenseCategory.findMany({ where: { id: { in: kinds.map((k) => k.categoryId) } }, select: { name: true } });
      for (const c of cats) kindsSeen.add(c.name);
    }
    expect(monthsChecked).toBeGreaterThan(0);
    // The seed's months carry each automatic source at least once.
    for (const name of ["Ad cost", "Damage / write-off", "Stock shortage", "Packaging used"]) expect([...kindsSeen], name).toContain(name);
  }, 300_000);

  it("each source posts exactly one expense, and nothing in a system heading is unaccounted for", async () => {
    // Ad spend ↔ "Ad cost": one each, same amount and day.
    const ad = await prisma.$queryRaw<{ bad: bigint }[]>`
      SELECT COUNT(*) AS bad FROM "daily_ad_spend" s
       WHERE s."deletedAt" IS NULL
         AND (SELECT COUNT(*) FROM "expenses" e WHERE e."adSpendId" = s."id" AND e."deletedAt" IS NULL AND e."amount" = s."amount" AND e."expenseDate" = s."spendDate") <> 1`;
    expect(Number(ad[0].bad), "ad spend rows without exactly one matching expense").toBe(0);
    const orphanAd = await prisma.expense.count({ where: { deletedAt: null, category: { kind: "AD_COST" }, adSpendId: null } });
    expect(orphanAd, "Ad cost expenses not posted by an ad spend row").toBe(0);

    // Damage and shortage: one per costed stock movement, at −qty × cost.
    const stock = await prisma.$queryRaw<{ bad: bigint }[]>`
      SELECT COUNT(*) AS bad FROM "stock_movements" m
       WHERE m."type"::text IN ('DAMAGE_OUT', 'ADJUSTMENT') AND m."qty" * m."unitCostSnapshot" <> 0
         AND COALESCE(m."referenceType"::text, '') <> 'OPENING_BALANCE'
         AND (SELECT COUNT(*) FROM "expenses" e WHERE e."stockMovementId" = m."id" AND e."deletedAt" IS NULL AND e."amount" = -m."qty" * m."unitCostSnapshot") <> 1`;
    expect(Number(stock[0].bad), "damage / adjustment movements without exactly one expense at cost").toBe(0);
    for (const kind of ["DAMAGE_WRITE_OFF", "STOCK_SHORTAGE"] as const) {
      expect(await prisma.expense.count({ where: { deletedAt: null, category: { kind, isSystem: true }, stockMovementId: null } }), kind).toBe(0);
    }

    // Cash over/short: one per closed drawer with a difference, = −difference.
    const drawers = await prisma.$queryRaw<{ bad: bigint }[]>`
      SELECT COUNT(*) AS bad FROM "cash_drawers" d
       WHERE d."closedAt" IS NOT NULL AND COALESCE(d."difference", 0) <> 0
         AND (SELECT COUNT(*) FROM "expenses" e WHERE e."cashDrawerId" = d."id" AND e."deletedAt" IS NULL AND e."amount" = -d."difference") <> 1`;
    expect(Number(drawers[0].bad), "closed drawers with a difference but not exactly one over/short expense").toBe(0);
    expect(await prisma.expense.count({ where: { deletedAt: null, category: { kind: "CASH_OVER_SHORT", isSystem: true }, cashDrawerId: null } })).toBe(0);

    // Courier: a reconciled statement posts its delivery charges less what
    // the condition check (return charges) and exchanges already posted for
    // its parcels, and its COD fees — once each.
    const statements = await prisma.courierStatement.findMany({
      where: { reconciledAt: { not: null } },
      select: { id: true, deliveryCharge: true, codCharge: true, deliveryChargeExpense: { select: { amount: true, deletedAt: true } }, codChargeExpense: { select: { amount: true, deletedAt: true } }, lines: { select: { shipmentId: true } } },
    });
    for (const s of statements) {
      const shipmentIds = s.lines.map((l) => l.shipmentId).filter((id): id is string => id !== null);
      const [ret, exch] = await Promise.all([
        prisma.expense.aggregate({ where: { deletedAt: null, returnChargeInspection: { shipmentId: { in: shipmentIds } } }, _sum: { amount: true } }),
        prisma.expense.aggregate({ where: { deletedAt: null, exchangeCourierCase: { replacementOrder: { shipment: { id: { in: shipmentIds } } } } }, _sum: { amount: true } }),
      ]);
      const expected = Math.max(toPaisa(s.deliveryCharge) - toPaisa(ret._sum.amount ?? 0) - toPaisa(exch._sum.amount ?? 0), 0);
      expect(s.deliveryChargeExpense ? toPaisa(s.deliveryChargeExpense.amount) : 0, `statement ${s.id} delivery`).toBe(expected);
      expect(s.codChargeExpense ? toPaisa(s.codChargeExpense.amount) : 0, `statement ${s.id} COD`).toBe(toPaisa(s.codCharge));
    }
    const courierSystem = await prisma.expense.findMany({
      where: { deletedAt: null, category: { kind: { in: ["COURIER", "EXCHANGE_RETURN"] }, isSystem: true } },
      select: { id: true, returnChargeInspectionId: true, exchangeCourierCaseId: true, statementDeliveryCharge: { select: { id: true } }, statementCodCharge: { select: { id: true } } },
    });
    for (const e of courierSystem) {
      const sources = [e.returnChargeInspectionId, e.exchangeCourierCaseId, e.statementDeliveryCharge?.id, e.statementCodCharge?.id].filter(Boolean);
      expect(sources.length, `courier expense ${e.id} has exactly one source`).toBe(1);
    }

    // Packaging used: one per order that used any, never a supplier purchase.
    const packaging = await prisma.expense.findMany({ where: { deletedAt: null, packagingOrderId: { not: null } }, select: { category: { select: { kind: true } } } });
    for (const p of packaging) expect(p.category.kind).toBe("PACKAGING");
    expect(await prisma.expense.count({ where: { deletedAt: null, category: { name: "Packaging used" }, packagingOrderId: null } })).toBe(0);
  }, 120_000);

  it("a scripted month: each source moves net by exactly its own amount; purchases and per-order allocation never do", async () => {
    const admin = await sessionUserFor(PHONES.ADMIN);
    const today = todayInDhaka();
    const monthStart = `${today.slice(0, 7)}-01`;
    await inRolledBackTransaction(async (tx) => {
      const check = async () => {
        const [pl, raw] = await Promise.all([plFor(tx, admin, monthStart, today), independentPl(tx, monthStart, today)]);
        expect(pl).toEqual(raw);
        return pl;
      };
      let prev = await check();
      const step = async (label: string, expected: Partial<PlLine>) => {
        const now = await check();
        const delta = { revenue: now.revenue - prev.revenue, cogs: now.cogs - prev.cogs, opex: now.opex - prev.opex, other: now.other - prev.other, net: now.net - prev.net };
        expect(delta, label).toEqual({ revenue: 0, cogs: 0, opex: 0, other: 0, ...expected, net: (expected.revenue ?? 0) - (expected.cogs ?? 0) - (expected.opex ?? 0) + (expected.other ?? 0) });
        prev = now;
      };
      const wallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH", isActive: true } });

      // A packed order: its total and frozen cost, nothing else.
      const { order } = await makePackedOrder(tx, { lines: 2, qty: 1 });
      const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const packagingExpense = await tx.expense.aggregate({ where: { packagingOrderId: order.id }, _sum: { amount: true } });
      await step("packed order", { revenue: toPaisa(order.total), cogs: items.reduce((a, i) => a + i.qty * toPaisa(i.unitCostSnapshot!), 0), opex: toPaisa(packagingExpense._sum.amount ?? 0) });

      // Ad spend: once, as its expense — however it's allocated to orders.
      await createAdSpend(tx, { spendDate: dhakaDayStartUtc(today), platform: "FACEBOOK", amount: 750, walletId: wallet.id }, admin.id);
      await step("ad spend", { opex: 75_000 });
      const method = await tx.setting.findUnique({ where: { key: "ad_cost_allocation" } });
      const flipped = JSON.stringify(method?.value) === JSON.stringify("BY_VALUE") ? "EQUAL" : "BY_VALUE";
      await tx.setting.upsert({ where: { key: "ad_cost_allocation" }, update: { value: flipped }, create: { key: "ad_cost_allocation", value: flipped } });
      await step("ad allocation method changed", {});

      // A supplier payment: cash out, never P&L.
      const purchase = await tx.expenseCategory.findFirstOrThrow({ where: { kind: "PURCHASE" } });
      await tx.expense.create({ data: { expenseDate: dhakaDayStartUtc(today), categoryId: purchase.id, nature: "VARIABLE", amount: 9_999, walletId: wallet.id } });
      await step("product purchase", {});

      // Damage and unexplained loss, each at cost.
      const variant = await tx.productVariant.findFirstOrThrow({ where: { isActive: true, weightedAvgCost: { gt: 0 }, locationStocks: { some: { locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: { gte: 5 } } } } });
      const cost = toPaisa(variant.weightedAvgCost);
      await writeOffDamagedStock(tx, { variantId: variant.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 1, reason: "Verify P4 — torn" }, admin.id);
      await step("damage write-off", { opex: cost });
      await adjustStock(tx, { variantId: variant.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: -2, reason: "Verify P4 — count short" }, admin.id);
      await step("stock shortage", { opex: 2 * cost });
      await adjustStock(tx, { variantId: variant.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 1, reason: "Verify P4 — found one" }, admin.id);
      await step("stock found", { opex: -cost });

      // A return with one damaged unit: revenue and cost leave with the
      // goods, the damaged unit is written off at cost, and the credit or
      // refund owed is neither income nor expense.
      const before = prev;
      const { order: returned } = await runReturnWithDamage(tx);
      const after = await check();
      const r = await tx.order.findUniqueOrThrow({ where: { id: returned.id }, include: { items: true } });
      expect(r.status).toBe("RETURNED");
      const [writeOff, packed] = await Promise.all([
        tx.expense.aggregate({ where: { stockMovement: { type: "DAMAGE_OUT", variantId: r.items[0].variantId } }, _sum: { amount: true } }),
        tx.expense.aggregate({ where: { packagingOrderId: r.id }, _sum: { amount: true } }),
      ]);
      expect(after.revenue - before.revenue, "a fully returned order carries no revenue").toBe(0);
      expect(after.cogs - before.cogs, "…and no cost of goods").toBe(0);
      expect(toPaisa(writeOff._sum.amount ?? 0), "one damaged unit, written off at its frozen cost").toBe(toPaisa(r.items[0].unitCostSnapshot!));
      expect(after.opex - before.opex, "write-off and the packaging it went out in — nothing for the refund or credit owed").toBe(toPaisa(writeOff._sum.amount ?? 0) + toPaisa(packed._sum.amount ?? 0));
      prev = after;
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 6. Store credit
// ---------------------------------------------------------------------------

describe("6. store credit in P&L (PRD §4.12)", () => {
  it("issuing isn't revenue, spending is; an Admin adjustment and expiry follow the rule", async () => {
    const admin = await sessionUserFor(PHONES.ADMIN);
    const today = todayInDhaka();
    const monthStart = `${today.slice(0, 7)}-01`;
    await inRolledBackTransaction(async (tx) => {
      const base = await plFor(tx, admin, monthStart, today);
      const customer = await tx.customer.findFirstOrThrow({ where: { deletedAt: null } });

      // + goodwill credit: a cost, not revenue.
      await adjustStoreCredit(tx, { customerId: customer.id, amount: 300, reason: "Verify P4 goodwill", actorId: admin.id });
      let pl = await plFor(tx, admin, monthStart, today);
      expect(pl.revenue - base.revenue).toBe(0);
      expect(pl.other - base.other, "a positive adjustment is a cost").toBe(-30_000);
      expect(pl.net - base.net).toBe(-30_000);

      // − taking credit back: income.
      await adjustStoreCredit(tx, { customerId: customer.id, amount: -100, reason: "Verify P4 correction", actorId: admin.id });
      pl = await plFor(tx, admin, monthStart, today);
      expect(pl.other - base.other).toBe(-20_000);

      // Credit that lapsed unspent this month: income. (Created earlier with
      // an expiry that has passed — as if the setting had been on.)
      const lapseAt = dhakaAt(today, "00:05");
      await tx.storeCreditEntry.create({
        data: { customerId: customer.id, type: "ADJUSTED", amount: 50, reason: "Verify P4 lapsing", createdAt: dhakaAt(monthStart, "00:01") < lapseAt ? dhakaAt(monthStart, "00:01") : new Date(lapseAt.getTime() - 60_000), expiresAt: lapseAt, createdById: admin.id },
      });
      pl = await plFor(tx, admin, monthStart, today);
      // The 50 added is a cost (adjustment) and its lapse is income: net zero,
      // but both lines show — and the independent recompute agrees.
      expect(pl.other - base.other).toBe(-20_000);
      expect(pl).toEqual(await independentPl(tx, monthStart, today));
    });
  }, 120_000);

  it("a counter sale paid with store credit is revenue at its full total; the credit rows are not money collected", async () => {
    const [admin] = await Promise.all([sessionUserFor(PHONES.ADMIN)]);
    const today = todayInDhaka();
    await inRolledBackTransaction(async (tx) => {
      const from = dhakaDayStartUtc(today);
      const to = dhakaDayStartUtc(today, 1);
      const before = await getProfitReport(tx, from, to);
      const pos = await userFor(tx, PHONES.POS);
      const customer = await tx.customer.create({ data: { name: "Verify P4 credit", phone: `0181${String(Date.now()).slice(-7)}`, createdById: pos.id } });
      await adjustStoreCredit(tx, { customerId: customer.id, amount: 5_000, reason: "Verify P4 credit to spend", actorId: admin.id });
      const variant = await tx.productVariant.findFirstOrThrow({ where: { isActive: true, stockQty: { gte: 3 }, product: { deletedAt: null, isActive: true, kind: "SELLABLE" } }, include: { product: true } });
      // C3 — a counter sale takes from the Shyamoli showroom: put one on its shelf, at the variant's own cost.
      const onShelf = (await tx.variantStock.findUnique({ where: { variantId_locationId: { variantId: variant.id, locationId: SEEDED_LOCATION_IDS.shyamoli } } }))?.qty ?? 0;
      if (onShelf < 1) await recordStockMovement(tx, { variantId: variant.id, locationId: SEEDED_LOCATION_IDS.shyamoli, type: "ADJUSTMENT", qty: 1 - onShelf, unitCost: variant.weightedAvgCost, referenceType: "OPENING_BALANCE", actorId: null });
      const { createPosSale } = await import("@/lib/pos/sale");
      const cash = await tx.wallet.findFirstOrThrow({ where: { type: "CASH", isActive: true } });
      const price = Number(variant.priceOverride ?? variant.product.basePrice);
      const sale = await createPosSale(tx, { user: pos, cashWalletId: cash.id, hasCostAccess: false, canCreateCustomer: true }, {
        items: [{ variantId: variant.id, qty: 1, unitPrice: price, lineDiscount: 0 }],
        cartDiscount: 0,
        customer: { phone: customer.phone },
        tenders: [{ method: "STORE_CREDIT", amount: price }],
      });
      const after = await getProfitReport(tx, from, to);
      expect(after.totals.revenuePaisa - before.totals.revenuePaisa).toBe(toPaisa(price));
      const collected = await tx.payment.aggregate({ where: { orderId: sale.orderId, kind: "PAYMENT" }, _sum: { amount: true } });
      expect(toPaisa(collected._sum.amount ?? 0), "credit spent is not money collected").toBe(0);
    });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 7. Dhaka day and month boundaries
// ---------------------------------------------------------------------------

describe("7. Dhaka day boundaries", () => {
  it("order numbers take the Dhaka month, not the server's", () => {
    // 00:30 on 1 Oct in Dhaka is 18:30 on 30 Sep in UTC.
    expect(orderNumberYearMonth(dhakaAt("2026-10-01", "00:30"))).toBe("2610");
    expect(orderNumberYearMonth(dhakaAt("2026-09-30", "23:59"))).toBe("2609");
  });

  it("an order at 00:30 Dhaka counts as that day — dashboards, reports, targets, leaderboard, profit; 23:59 the night before doesn't", async () => {
    const [admin, se] = await Promise.all([sessionUserFor(PHONES.ADMIN), sessionUserFor(PHONES.SE)]);
    // Yesterday (always in the past), seen from 23:00 that night.
    const day = shiftDay(todayInDhaka(), -1);
    const now = dhakaAt(day, "23:00");
    await inRolledBackTransaction(async (tx) => {
      const seRow = await tx.user.findUniqueOrThrow({ where: { id: se.id } });
      const customer = await tx.customer.findFirstOrThrow({ where: { createdById: se.id, deletedAt: null } });
      const place = (at: Date, total: number) =>
        tx.order.create({ data: { orderNo: `VP4-${at.getTime()}-${total}`, status: "CONFIRMED", customerId: customer.id, subtotal: total, total, dueAmount: total, createdById: se.id, teamId: seRow.teamId, createdAt: at } });

      const snap = async () => {
        const [owner, sales, r1, stats, board, profit] = await Promise.all([
          getOwnerNumbers(tx, admin, now),
          getSalesNumbers(tx, se, now),
          reportFor(tx, admin, "sales", { from: day, to: day }, now),
          statsByUser(tx, dhakaMonth(now), [se.id]),
          getLeaderboard(tx, admin, "all", dhakaMonth(now), "value"),
          getProfitReport(tx, dhakaDayStart(day), dhakaDayStart(day, 1)),
        ]);
        return {
          ownerToday: owner.today.orders,
          seToday: sales.today.orders,
          r1: Number(fig(r1, "Orders")),
          target: stats.get(se.id)?.orderCount ?? 0,
          board: board.rows.find((x) => x.userId === se.id)?.stats.orderCount ?? 0,
          revenueOut: profit.totals.revenuePaisa,
        };
      };
      const before = await snap();
      await place(dhakaAt(day, "00:30"), 1_111);
      await place(dhakaAt(shiftDay(day, -1), "23:59"), 2_222);
      const late = await place(dhakaAt(shiftDay(day, -1), "22:00"), 3_333);
      // Packed at 00:30 Dhaka: its revenue is that day's.
      await tx.orderStatusHistory.create({ data: { orderId: late.id, fromStatus: "CONFIRMED", toStatus: "PACKED", changedById: admin.id, createdAt: dhakaAt(day, "00:30") } });
      await tx.order.update({ where: { id: late.id }, data: { status: "PACKED" } });
      const after = await snap();
      const sameMonth = day.slice(0, 7) === shiftDay(day, -1).slice(0, 7);
      expect({
        ownerToday: after.ownerToday - before.ownerToday,
        seToday: after.seToday - before.seToday,
        r1: after.r1 - before.r1,
        revenueOut: after.revenueOut - before.revenueOut,
      }).toEqual({ ownerToday: 1, seToday: 1, r1: 1, revenueOut: 333_300 });
      // The month counts all three when the day before is in the same month, only the 00:30 one otherwise.
      expect(after.target - before.target).toBe(sameMonth ? 3 : 1);
      expect(after.board - before.board).toBe(sameMonth ? 3 : 1);
    });
  }, 120_000);

  it("month edges: 00:30 on the 1st is this month's target, R1 and P&L; 23:59 on the last day is last month's", async () => {
    const [admin, se] = await Promise.all([sessionUserFor(PHONES.ADMIN), sessionUserFor(PHONES.SE)]);
    const month = dhakaMonth();
    const first = `${month}-01`;
    const lastOfPrev = shiftDay(first, -1);
    const prev = shiftMonth(month, -1);
    const today = todayInDhaka();
    await inRolledBackTransaction(async (tx) => {
      const seRow = await tx.user.findUniqueOrThrow({ where: { id: se.id } });
      const customer = await tx.customer.findFirstOrThrow({ where: { createdById: se.id, deletedAt: null } });
      const wallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH", isActive: true } });
      const misc = await tx.expenseCategory.findFirstOrThrow({ where: { kind: "MISC", isSystem: false } });
      const snap = async () => {
        const [cur, old, r1cur, r1old, plCur, plOld] = await Promise.all([
          statsByUser(tx, month, [se.id]),
          statsByUser(tx, prev, [se.id]),
          reportFor(tx, admin, "sales", { from: first, to: today }),
          reportFor(tx, admin, "sales", { from: `${prev}-01`, to: lastOfPrev }),
          plFor(tx, admin, first, today),
          plFor(tx, admin, `${prev}-01`, lastOfPrev),
        ]);
        return { cur: cur.get(se.id)?.orderCount ?? 0, old: old.get(se.id)?.orderCount ?? 0, r1cur: Number(fig(r1cur, "Orders")), r1old: Number(fig(r1old, "Orders")), opexCur: plCur.opex, opexOld: plOld.opex };
      };
      const before = await snap();
      for (const [at, total] of [[dhakaAt(first, "00:30"), 101], [dhakaAt(lastOfPrev, "23:59"), 202]] as const) {
        await tx.order.create({ data: { orderNo: `VP4M-${at.getTime()}`, status: "CONFIRMED", customerId: customer.id, subtotal: total, total, dueAmount: total, createdById: se.id, teamId: seRow.teamId, createdAt: at } });
      }
      // Expenses are dated by Dhaka day (and posted ones at their moment).
      await tx.expense.create({ data: { expenseDate: dhakaDayStartUtc(first), categoryId: misc.id, nature: "VARIABLE", amount: 10, walletId: wallet.id } });
      await tx.expense.create({ data: { expenseDate: dhakaAt(first, "00:30"), categoryId: misc.id, nature: "VARIABLE", amount: 20, walletId: wallet.id } });
      await tx.expense.create({ data: { expenseDate: dhakaAt(lastOfPrev, "23:59"), categoryId: misc.id, nature: "VARIABLE", amount: 40, walletId: wallet.id } });
      const after = await snap();
      expect({ cur: after.cur - before.cur, old: after.old - before.old, r1cur: after.r1cur - before.r1cur, r1old: after.r1old - before.r1old, opexCur: after.opexCur - before.opexCur, opexOld: after.opexOld - before.opexOld }).toEqual({
        cur: 1,
        old: 1,
        r1cur: 1,
        r1old: 1,
        opexCur: 3_000,
        opexOld: 4_000,
      });
    });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 8. Every dashboard number equals the total of the list it opens
// ---------------------------------------------------------------------------

async function orderList(href: string) {
  const url = new URL(href, "http://localhost");
  url.pathname = "/api/orders";
  url.searchParams.set("pageSize", "1");
  const body = await getJson(ordersGET, url.pathname + url.search);
  return { total: body.total as number, value: toPaisa(body.totalValue), due: toPaisa(body.totalDue) };
}

describe("8. every dashboard number is the list it opens", () => {
  it("owner and accounts: collected, expenses, unverified, COD, low stock, follow-ups", async () => {
    for (const phone of [PHONES.ADMIN, PHONES.ACCOUNTS]) {
      const user = await sessionUserFor(phone);
      asSession(user);
      const accounts = await getAccountsNumbers(prisma, user, { cod: true, wallets: false, expenses: true });
      const today = accounts.ranges.todayRange;
      const collection = await getJson(collectionGET, `/api/reports/collection?from=${today.from}&to=${today.to}`);
      expect(toPaisa(accounts.collected.amount), `${phone} collected today`).toBe(toPaisa(collection.report.totals.collected));
      expect(accounts.collected.count).toBe(collection.report.totals.paymentCount);
      const exp = await getJson(expensesGET, expensesHref(today).replace("/expenses", "/api/expenses"));
      expect([accounts.expenses.count, toPaisa(accounts.expenses.amount)], `${phone} expenses today`).toEqual([exp.total, toPaisa(exp.totalAmount)]);
      const payments = await getJson(paymentsGET, "/api/payments?view=unverified&pageSize=1");
      expect(accounts.unverified.count).toBe(payments.total);
      const cod = await getJson(codGET, codHref().replace("/courier?tab=cod", "/api/courier/cod?view=awaiting&pageSize=1"));
      expect(accounts.cod!.count, "COD pending").toBe(cod.total);
      const late = await getJson(codGET, codHref({ overdue: true }).replace("/courier?tab=cod", "/api/courier/cod?view=awaiting&pageSize=1"));
      expect(accounts.cod!.overdueCount, `COD not received after ${COD_OVERDUE_DAYS} days`).toBe(late.total);
    }

    const admin = await sessionUserFor(PHONES.ADMIN);
    asSession(admin);
    const n = await getOwnerNumbers(prisma, admin);
    for (const [row, range] of [
      [n.today, n.ranges.todayRange],
      [n.inPeriod, n.ranges.mtdRange],
    ] as const) {
      const collection = await getJson(collectionGET, collectionHref(range).replace("/payments/collection", "/api/reports/collection"));
      expect(toPaisa(row.collected)).toBe(toPaisa(collection.report.totals.collected));
      const exp = await getJson(expensesGET, expensesHref(range, OPERATING_EXPENSE_FILTER).replace("/expenses", "/api/expenses"));
      expect(toPaisa(row.expenses)).toBe(toPaisa(exp.totalAmount));
    }
    const low = await getLowStockSummary();
    const lowList = await getJson(lowStockGET, "/api/inventory/low-stock");
    expect(low.variants).toBe(lowList.alerts.reduce((a: number, p: { lowVariants: unknown[] }) => a + p.lowVariants.length, 0));

    // Follow-ups: the dashboard's counts are the follow-ups screen's.
    for (const phone of [PHONES.ADMIN, PHONES.SE, PHONES.TL]) {
      const user = await sessionUserFor(phone);
      asSession(user);
      const due = await listDueFollowUps(prisma, user);
      const page = await listDueFollowUps(prisma, user, { days: 7, limit: 300 });
      expect(followUpsHref()).toBe("/leads/follow-ups");
      expect([due.overdue, due.dueToday], phone).toEqual([page.overdue, page.dueToday]);
      const open = await getJson(leadsGET, "/api/leads?status=open&pageSize=1");
      const sales = await getSalesNumbers(prisma, user);
      if (phone !== PHONES.ADMIN) expect(sales.leadsOpen, `${phone} open leads`).toBe(open.total);
    }
  }, 300_000);

  it("sales floor: status bars, approvals and the leaderboard rows open lists with the same totals", async () => {
    for (const phone of [PHONES.SE, PHONES.TL]) {
      const user = await sessionUserFor(phone);
      asSession(user);
      const n = await getSalesNumbers(prisma, user);
      for (const s of n.closedInPeriod) expect((await orderList(ordersHref({ status: s.status, range: n.ranges.mtdRange }))).total, `${phone} ${s.status}`).toBe(s.count);
      const today = await orderList(ordersHref({ preset: "sales", range: n.ranges.todayRange }));
      expect([today.total, today.value]).toEqual([n.today.orders, toPaisa(n.today.value)]);
      const approvals = await getPendingApprovals(prisma, user);
      if (approvals?.returns != null) expect((await listReturnCases(prisma, user, { tab: "requested", type: "RETURN", page: 1, pageSize: 1 })).total).toBe(approvals.returns);
      if (approvals?.exchanges != null) expect((await listReturnCases(prisma, user, { tab: "requested", type: "EXCHANGE", page: 1, pageSize: 1 })).total).toBe(approvals.exchanges);
    }
    const admin = await sessionUserFor(PHONES.ADMIN);
    asSession(admin);
    const month = dhakaMonth();
    const board = await getLeaderboard(prisma, admin, "all", month, "value");
    const mtd = { from: `${month}-01`, to: todayInDhaka() };
    for (const r of board.rows.slice(0, 5)) {
      const list = await orderList(ordersHref({ preset: "sales", createdById: r.userId, range: mtd }));
      expect([list.total, list.value], r.name).toEqual([r.stats.orderCount, toPaisa(r.stats.salesValue)]);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 9. Online / Walk-in adds up
// ---------------------------------------------------------------------------

describe("9. the Online / Walk-in split adds up to the totals", () => {
  it("on the owner dashboard, and in R14 for every role that runs it", async () => {
    const admin = await sessionUserFor(PHONES.ADMIN);
    asSession(admin);
    const n = await getOwnerNumbers(prisma, admin);
    const range = n.ranges.chartRange;
    const all = await orderList(ordersHref({ preset: "sales", range }));
    const online = await orderList(ordersHref({ preset: "sales", channel: "ONLINE", range }));
    const walkIn = await orderList(ordersHref({ preset: "sales", channel: "WALK_IN", range }));
    expect([n.channel.onlineOrders, toPaisa(n.channel.online)]).toEqual([online.total, online.value]);
    expect([n.channel.walkInOrders, toPaisa(n.channel.walkIn)]).toEqual([walkIn.total, walkIn.value]);
    expect([online.total + walkIn.total, online.value + walkIn.value]).toEqual([all.total, all.value]);
    expect(n.days.reduce((a, d) => a + d.orders, 0)).toBe(all.total);
    expect(toPaisa(n.days.reduce((a, d) => a + d.online + d.walkIn, 0).toFixed(2))).toBe(all.value);

    const ytd = { from: `${todayInDhaka().slice(0, 4)}-01-01`, to: todayInDhaka() };
    for (const phone of [PHONES.ADMIN, PHONES.MANAGER, PHONES.TL, PHONES.SE]) {
      const user = await sessionUserFor(phone);
      asSession(user);
      const res = await reportGET(new NextRequest(`http://localhost/api/reports/channels?from=${ytd.from}&to=${ytd.to}`), { params: Promise.resolve({ report: "channels" }) });
      expect(res.status, phone).toBe(200);
      const r14 = (await res.json()).report as ReportResult;
      const t = r14.tables.find((x) => x.id === "by-channel")!;
      const sum = (k: string) => t.rows.reduce((a, row) => a + (k === "orders" || k === "units" ? Number(row[k]) : paisaOf(row[k])), 0);
      for (const k of ["orders", "units", "value", ...(t.columns.some((c) => c.key === "totalCost") ? ["outValue", "totalCost", "profit"] : [])]) {
        expect(sum(k), `${phone} R14 ${k}`).toBe(k === "orders" || k === "units" ? Number(t.totals![k]) : paisaOf(t.totals![k]));
      }
      const byMonth = r14.tables.find((x) => x.id === "by-month")!;
      expect(byMonth.rows.reduce((a, row) => a + Number(row.onlineOrders) + Number(row.walkInOrders), 0), `${phone} R14 by month`).toBe(Number(t.totals!.orders));
      // …and each channel row is R1 run for that channel.
      for (const ch of ["ONLINE", "WALK_IN"] as const) {
        const r1 = await reportFor(prisma, user, "sales", { ...ytd, channel: ch });
        const row = t.rows.find((x) => x.channel === (ch === "ONLINE" ? "Online" : "Walk-in"))!;
        expect([Number(row.orders), paisaOf(row.value)], `${phone} ${ch}`).toEqual([Number(fig(r1, "Orders")), paisaOf(fig(r1, "Order value"))]);
      }
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 10. Cancelled and returned orders stop counting
// ---------------------------------------------------------------------------

describe("10. a cancelled or returned order stops counting towards targets and the leaderboard", () => {
  it("cancelling takes it off; a customer return takes it off and shows it under quality", async () => {
    const admin = await sessionUserFor(PHONES.ADMIN);
    const month = dhakaMonth();
    await inRolledBackTransaction(async (tx) => {
      const se = await userFor(tx, PHONES.SE);
      const snap = async () => {
        const [stats, board, dash] = await Promise.all([statsByUser(tx, month, [se.id]), getLeaderboard(tx, admin, "all", month, "value"), getSalesNumbers(tx, se)]);
        const s = stats.get(se.id)!;
        const row = board.rows.find((r) => r.userId === se.id)!;
        return { value: s.salesPaisa, orders: s.orderCount, returned: s.returned, boardValue: toPaisa(row.stats.salesValue), boardOrders: row.stats.orderCount, dashValue: toPaisa(dash.inPeriod.value) };
      };
      const base = await snap();

      // Confirmed → counts. Cancelled → gone.
      const { order } = await makePackedOrder(tx, { lines: 1, qty: 1 });
      const counted = await snap();
      expect(counted.value - base.value).toBe(toPaisa(order.total));
      expect(counted.boardValue - base.boardValue).toBe(toPaisa(order.total));
      expect(counted.dashValue - base.dashValue).toBe(toPaisa(order.total));
      const packedItems = await tx.orderItem.findMany({ where: { orderId: order.id }, select: { variantId: true, qty: true, unitCostSnapshot: true } });
      await moveOrderStatus(tx, { id: order.id, status: "PACKED", items: packedItems }, "CANCELLED", admin.id, "Verify P4 cancel");
      expect(await snap()).toEqual(base);

      // Delivered, then every unit returned by the customer.
      const { order: back } = await runReturnWithDamage(tx);
      const after = await snap();
      expect((await tx.order.findUniqueOrThrow({ where: { id: back.id } })).status).toBe("RETURNED");
      expect({ value: after.value, orders: after.orders, boardValue: after.boardValue, boardOrders: after.boardOrders, dashValue: after.dashValue }).toEqual({
        value: base.value,
        orders: base.orders,
        boardValue: base.boardValue,
        boardOrders: base.boardOrders,
        dashValue: base.dashValue,
      });
      expect(after.returned - base.returned, "shown under quality instead").toBe(1);
    });
  }, 180_000);
});
