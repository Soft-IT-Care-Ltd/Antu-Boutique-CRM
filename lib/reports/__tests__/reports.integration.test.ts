import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));
vi.mock("@/lib/courier/steadfast/client");

import { GET as auditGET } from "@/app/api/audit-logs/route";
import { GET as stockGET } from "@/app/api/inventory/stock/route";
import { GET as ordersGET } from "@/app/api/orders/route";
import { GET as exportGET } from "@/app/api/reports/[report]/export/route";
import { GET as reportGET } from "@/app/api/reports/[report]/route";
import { listAuditLogs } from "@/lib/audit/queries";
import type { SessionUser } from "@/lib/auth/types";
import { makePackedOrder, sessionUserFor } from "@/lib/courier/__tests__/helpers";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { toPaisa } from "@/lib/inventory/costing";
import { prisma } from "@/lib/prisma";
import { canRunReport } from "@/lib/reports/access";
import { REPORT_BY_KEY, REPORT_KEYS, type ReportKey } from "@/lib/reports/catalog";
import { reportToCsv } from "@/lib/reports/export";
import { parseReportFilters } from "@/lib/reports/filters";
import { runReport } from "@/lib/reports/run";
import type { ReportResult } from "@/lib/reports/types";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// P4.4 (PRD §4.15) — every report runs for every role that may run it; an
// executive's reports hold only their own data and never a cost field; the
// sales report reconciles with the order list; the P&L's COGS is the
// frozen snapshot; exports and the audit log are gated. Reads the seeded
// demo data; writes run in rolled-back transactions.

const PHONES = { ADMIN: "01711000001", MANAGER: "01711000002", TL: "01711000003", SE: "01711000004", PACKING: "01711000005", ACCOUNTS: "01711000006", POS: "01711000007" } as const;

// Every key lib/auth/strip-cost-fields.ts removes — none may reach an SE.
const COST_KEY = /"(cost|costPrice|unitCost|unitCostSnapshot|purchasePrice|purchaseCost|weightedAvgCost|totalCost|profit|totalProfit|margin|marginPercent|valueAtCost|courierCostActual|courierCostEstimate|companyCourierCost)"\s*:/;
const COST_LABEL = /cost|profit|margin/i;

function asSession(user: SessionUser | null) {
  session.current = user ? { user: { id: user.id, role: user.role, teamId: user.teamId } } : null;
}

async function getReport(key: string, query = ""): Promise<{ status: number; body: { report?: ReportResult; error?: string } }> {
  const res = await reportGET(new NextRequest(`http://localhost/api/reports/${key}?${query}`), { params: Promise.resolve({ report: key }) });
  return { status: res.status, body: await res.json() };
}

const figure = (r: ReportResult, label: string) => r.figures.find((f) => f.label === label)?.value;

/** Year to date: enough seeded orders to make the numbers mean something. */
const YTD = `from=${todayInDhaka().slice(0, 4)}-01-01&to=${todayInDhaka()}`;

beforeEach(() => {
  session.current = null;
});

describe("who can run which report", () => {
  it("follows each report's module permission, on top of report.view", async () => {
    const got: Record<string, ReportKey[]> = {};
    for (const [name, phone] of Object.entries(PHONES)) {
      const user = await sessionUserFor(phone);
      got[name] = [];
      for (const k of REPORT_KEYS) if (await canRunReport(user, k)) got[name].push(k);
    }
    expect(got.ADMIN).toEqual([...REPORT_KEYS]);
    expect(got.MANAGER).toEqual([...REPORT_KEYS]);
    // An executive: their own sales-side reports — no courier, money or P&L.
    expect(got.SE).toEqual(["sales", "leads", "team", "stock", "sets", "attendance", "cancellations", "customers", "exchanges", "channels"]);
    expect(got.TL).not.toContain("pl");
    expect(got.TL).not.toContain("expense");
    expect(got.ACCOUNTS).toEqual(expect.arrayContaining(["collections", "expense", "courier", "sales"]));
    expect(got.ACCOUNTS).not.toContain("pl");
    // Packing and the till hold no report.view.
    expect(got.PACKING).toEqual([]);
    expect(got.POS).toEqual([]);
  }, 120_000);

  it("refuses the route for a report the user may not run, and an unknown one", async () => {
    asSession(await sessionUserFor(PHONES.SE));
    expect((await getReport("pl")).status).toBe(403);
    expect((await getReport("collections")).status).toBe(403);
    expect((await getReport("nope")).status).toBe(404);
    asSession(await sessionUserFor(PHONES.PACKING));
    expect((await getReport("stock")).status).toBe(403);
  });

  it("validates the filters", async () => {
    asSession(await sessionUserFor(PHONES.ADMIN));
    expect((await getReport("sales", "from=2026-09-10&to=2026-09-01")).status).toBe(400);
    expect((await getReport("sales", "channel=SOMETHING")).status).toBe(400);
    expect((await getReport("sales", "from=2020-01-01&to=2026-01-01")).status).toBe(400);
  });
});

describe("every report runs for every role that may run it", () => {
  it("builds R1–R14 for each role without error, and an SE's never carry a cost field", async () => {
    for (const [name, phone] of Object.entries(PHONES)) {
      const user = await sessionUserFor(phone);
      asSession(user);
      for (const k of REPORT_KEYS) {
        if (!(await canRunReport(user, k))) continue;
        const { status, body } = await getReport(k, YTD);
        expect(status, `${name} ${k}: ${body.error}`).toBe(200);
        expect(body.report!.code).toBe(REPORT_BY_KEY[k].code);
        if (name === "SE" || name === "TL") {
          const json = JSON.stringify(body.report);
          expect(json, `${name} ${k}`).not.toMatch(COST_KEY);
          expect(json).not.toContain('"costOnly"');
          for (const t of body.report!.tables) for (const c of t.columns) expect(c.label, `${name} ${k} ${t.id}`).not.toMatch(COST_LABEL);
          for (const f of body.report!.figures) expect(f.label, `${name} ${k}`).not.toMatch(COST_LABEL);
        }
      }
    }
  }, 600_000);

  it("keeps the cost columns for Admin (stock value, channel margin, courier charges)", async () => {
    asSession(await sessionUserFor(PHONES.ADMIN));
    const stock = (await getReport("stock")).body.report!;
    expect(stock.tables[0].columns.map((c) => c.key)).toContain("valueAtCost");
    expect(figure(stock, "Value at cost")).not.toBeUndefined();
    const channels = (await getReport("channels", YTD)).body.report!;
    expect(channels.tables[0].columns.map((c) => c.key)).toEqual(expect.arrayContaining(["totalCost", "profit", "margin"]));
    asSession(await sessionUserFor(PHONES.SE));
    const seStock = (await getReport("stock")).body.report!;
    expect(seStock.tables[0].columns.map((c) => c.key)).not.toContain("valueAtCost");
    expect(seStock.tables[0].rows.every((r) => !("valueAtCost" in r) && !("unitCost" in r))).toBe(true);
  });
});

describe("scoping (CLAUDE.md rule 6)", () => {
  it("an executive's sales report is exactly their own orders, and naming another executive can't widen it", async () => {
    const se = await sessionUserFor(PHONES.SE);
    const other = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000008" } });
    asSession(se);
    const own = (await getReport("sales", YTD)).body.report!;
    const people = own.tables.find((t) => t.id === "by-person")!;
    expect(people.rows.length).toBeLessThanOrEqual(1);
    const from = dhakaDayStartUtc(`${todayInDhaka().slice(0, 4)}-01-01`);
    const direct = await prisma.order.aggregate({
      where: { createdById: se.id, deletedAt: null, exchangedFromOrderId: null, status: { notIn: ["LEAD", "CANCELLED", "RETURNED", "REFUNDED"] }, createdAt: { gte: from, lt: dhakaDayStartUtc(todayInDhaka(), 1) } },
      _sum: { total: true },
      _count: { _all: true },
    });
    expect(figure(own, "Orders")).toBe(direct._count._all);
    expect(toPaisa(String(figure(own, "Order value")))).toBe(toPaisa(direct._sum.total ?? 0));

    const widened = (await getReport("sales", `${YTD}&person=${other.id}`)).body.report!;
    expect(figure(widened, "Orders")).toBe(0);
    // …and the header (screen, CSV, PDF) doesn't name them either.
    expect(widened.applied).toContainEqual({ label: "Person", value: "Not in your view" });
    expect(JSON.stringify(widened)).not.toContain(other.name);
    const team = (await getReport("team", `${YTD}&person=${other.id}`)).body.report!;
    expect(team.tables[0].rows).toEqual([]);
  });

  it("an executive's team-performance and attendance reports hold only their own row", async () => {
    const se = await sessionUserFor(PHONES.SE);
    const name = (await prisma.user.findUniqueOrThrow({ where: { id: se.id } })).name;
    asSession(se);
    for (const k of ["team", "attendance"]) {
      const rows = (await getReport(k, YTD)).body.report!.tables[0].rows;
      expect(rows.map((r) => r.name)).toEqual([name]);
    }
  });

  it("a team leader's sales report covers their team only", async () => {
    const tl = await sessionUserFor(PHONES.TL);
    asSession(tl);
    const r = (await getReport("sales", YTD)).body.report!;
    const members = await prisma.user.findMany({ where: { teamId: tl.teamId }, select: { name: true } });
    const names = new Set(members.map((m) => m.name));
    for (const row of r.tables.find((t) => t.id === "by-person")!.rows) expect(names.has(String(row.name))).toBe(true);
  });
});

describe("totals reconcile with the underlying lists", () => {
  it("R1 Orders and value equal the order list's 'Counted as sales' slice, for the same user and filter", async () => {
    for (const phone of [PHONES.ADMIN, PHONES.SE, PHONES.TL]) {
      asSession(await sessionUserFor(phone));
      for (const extra of ["", "&channel=ONLINE", "&channel=WALK_IN"]) {
        const r = (await getReport("sales", YTD + extra)).body.report!;
        const list = await ordersGET(new NextRequest(`http://localhost/api/orders?preset=sales&${YTD}${extra}&pageSize=1`));
        const body = await list.json();
        expect(figure(r, "Orders"), `${phone}${extra}`).toBe(body.total);
        expect(Number(figure(r, "Order value"))).toBeCloseTo(Number(body.totalValue), 2);
        // The per-period, per-channel and per-person tables add back to the total.
        const byPeriod = r.tables.find((t) => t.id === "by-period")!;
        expect(byPeriod.rows.reduce((a, x) => a + toPaisa(String(x.value)), 0)).toBe(toPaisa(String(figure(r, "Order value"))));
        const byPerson = r.tables.find((t) => t.id === "by-person")!;
        expect(byPerson.rows.reduce((a, x) => a + Number(x.orders), 0)).toBe(body.total);
      }
    }
  }, 300_000);

  it("with a status picked, R1 still equals the list its Orders figure opens (exchange replacements on both sides or neither)", async () => {
    for (const phone of [PHONES.ADMIN, PHONES.SE]) {
      asSession(await sessionUserFor(phone));
      for (const status of ["COMPLETED", "DELIVERED", "RETURNED", "CANCELLED"]) {
        const r = (await getReport("sales", `${YTD}&status=${status}`)).body.report!;
        const href = r.figures.find((f) => f.label === "Orders")!.href!;
        const body = await (await ordersGET(new NextRequest(`http://localhost/api${href}&pageSize=1`))).json();
        expect(figure(r, "Orders"), `${phone} ${status}`).toBe(body.total);
        expect(toPaisa(String(figure(r, "Order value")))).toBe(toPaisa(body.totalValue));
      }
    }
  }, 120_000);

  it("R14's online + walk-in add up to R1", async () => {
    asSession(await sessionUserFor(PHONES.ADMIN));
    const sales = (await getReport("sales", YTD)).body.report!;
    const channels = (await getReport("channels", YTD)).body.report!;
    expect(channels.tables[0].totals!.orders).toBe(figure(sales, "Orders"));
    expect(channels.tables[0].totals!.value).toBe(figure(sales, "Order value"));
  });
});

describe("P&L (PRD §4.12)", () => {
  it("is Admin/Manager only", async () => {
    for (const phone of [PHONES.TL, PHONES.ACCOUNTS, PHONES.SE]) {
      asSession(await sessionUserFor(phone));
      expect((await getReport("pl")).status).toBe(403);
    }
    asSession(await sessionUserFor(PHONES.MANAGER));
    expect((await getReport("pl")).status).toBe(200);
  });

  it("takes COGS from unit_cost_snapshot — changing today's cost afterwards doesn't move it", async () => {
    const admin = await sessionUserFor(PHONES.ADMIN);
    const def = REPORT_BY_KEY.pl;
    const today = todayInDhaka();
    const parsed = parseReportFilters(def, { from: today, to: today });
    if (!parsed.ok) throw new Error(parsed.error);
    await inRolledBackTransaction(async (tx) => {
      const before = await runReport(tx, admin, "pl", parsed.filters);
      const { order } = await makePackedOrder(tx, { lines: 2, qty: 2 });
      const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const snapshotCogs = items.reduce((a, i) => a + i.qty * toPaisa(i.unitCostSnapshot!), 0);
      const afterPack = await runReport(tx, admin, "pl", parsed.filters);
      const cogs = (r: ReportResult) => toPaisa(String(figure(r, "Cost of goods")));
      const revenue = (r: ReportResult) => toPaisa(String(figure(r, "Revenue")));
      expect(cogs(afterPack) - cogs(before)).toBe(snapshotCogs);
      expect(revenue(afterPack) - revenue(before)).toBe(toPaisa(order.total));

      // Today's purchase price jumps: history must not move.
      await tx.productVariant.updateMany({ where: { id: { in: items.map((i) => i.variantId) } }, data: { weightedAvgCost: 99_999 } });
      const afterPriceChange = await runReport(tx, admin, "pl", parsed.filters);
      expect(cogs(afterPriceChange)).toBe(cogs(afterPack));

      // Net = gross − operating expenses (+ store-credit income); supplier payments stay out.
      const wallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
      const purchase = await tx.expenseCategory.findFirstOrThrow({ where: { kind: "PURCHASE" } });
      await tx.expense.create({ data: { expenseDate: dhakaDayStartUtc(today), categoryId: purchase.id, nature: "VARIABLE", amount: 5000, walletId: wallet.id } });
      const afterPurchase = await runReport(tx, admin, "pl", parsed.filters);
      expect(figure(afterPurchase, "Operating expenses")).toBe(figure(afterPriceChange, "Operating expenses"));
      const m = afterPurchase.tables.find((t) => t.id === "month-on-month")!.totals!;
      expect(toPaisa(String(m.net))).toBe(toPaisa(String(m.gross)) - toPaisa(String(m.opex)) + toPaisa(String(m.other)));
    });
  }, 120_000);
});

describe("exports", () => {
  it("need report.export, and carry the same scoped, cost-free numbers as the screen", async () => {
    asSession(await sessionUserFor(PHONES.SE));
    const denied = await exportGET(new NextRequest("http://localhost/api/reports/sales/export?format=csv"), { params: Promise.resolve({ report: "sales" }) });
    expect(denied.status).toBe(403);

    // Were an executive ever granted export, the file is built from the same result.
    const se = await sessionUserFor(PHONES.SE);
    const parsed = parseReportFilters(REPORT_BY_KEY.stock, {});
    if (!parsed.ok) throw new Error(parsed.error);
    const csv = reportToCsv(await runReport(prisma, se, "stock", parsed.filters));
    expect(csv).not.toMatch(COST_LABEL);
    expect(csv).toContain("On hand");

    asSession(await sessionUserFor(PHONES.MANAGER));
    const res = await exportGET(new NextRequest(`http://localhost/api/reports/sales/export?format=csv&${YTD}`), { params: Promise.resolve({ report: "sales" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const screen = (await getReport("sales", YTD)).body.report!;
    expect(text).toContain(`Orders,${figure(screen, "Orders")}`);
    expect(text).toContain(`Order value,${Number(figure(screen, "Order value")).toFixed(2)}`);

    const bad = await exportGET(new NextRequest("http://localhost/api/reports/sales/export?format=xlsx"), { params: Promise.resolve({ report: "sales" }) });
    expect(bad.status).toBe(400);
  });
});

describe("stock routes an executive reaches", () => {
  it("answer (no BigInt in the JSON) and carry no cost", async () => {
    asSession(await sessionUserFor(PHONES.SE));
    const res = await stockGET(new NextRequest("http://localhost/api/inventory/stock?pageSize=100"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(COST_KEY);
    expect(JSON.parse(text).items.every((i: { threshold: unknown }) => typeof i.threshold === "number")).toBe(true);
  });
});

describe("audit log viewer", () => {
  it("drops cost fields from before/after for anyone granted audit.view without product.cost.view", async () => {
    await inRolledBackTransaction(async (tx) => {
      const variant = await tx.productVariant.findFirstOrThrow({ select: { id: true } });
      await tx.auditLog.create({ data: { action: "inventory.adjust", entityType: "product_variant", entityId: variant.id, before: { stockQty: 5, weightedAvgCost: "410.00" }, after: { stockQty: 3, weightedAvgCost: "410.00", unitCost: "410.00" } } });
      const f = { entityId: variant.id, page: 1 };
      const admin = await listAuditLogs(tx, f, true);
      expect(JSON.stringify(admin)).toMatch(COST_KEY);
      const other = await listAuditLogs(tx, f, false);
      expect(JSON.stringify(other)).not.toMatch(COST_KEY);
      expect(other.items[0].after).toEqual({ stockQty: 3 });
      expect(other.items[0].changed).toEqual(["stockQty"]);
    });
  });

  it("is Admin only, and filters by person, record type and date", async () => {
    for (const phone of [PHONES.MANAGER, PHONES.SE, PHONES.ACCOUNTS]) {
      asSession(await sessionUserFor(phone));
      expect((await auditGET(new NextRequest("http://localhost/api/audit-logs"))).status).toBe(403);
    }
    const admin = await sessionUserFor(PHONES.ADMIN);
    asSession(admin);
    const all = await (await auditGET(new NextRequest("http://localhost/api/audit-logs"))).json();
    expect(all.total).toBeGreaterThan(0);
    const sample = all.items[0];
    const byEntity = await (await auditGET(new NextRequest(`http://localhost/api/audit-logs?entity=${sample.entityType}`))).json();
    expect(byEntity.items.every((i: { entityType: string }) => i.entityType === sample.entityType)).toBe(true);
    if (sample.actor) {
      const byActor = await (await auditGET(new NextRequest(`http://localhost/api/audit-logs?actor=${sample.actor.id}`))).json();
      expect(byActor.items.every((i: { actor: { id: string } | null }) => i.actor?.id === sample.actor.id)).toBe(true);
    }
    const none = await (await auditGET(new NextRequest("http://localhost/api/audit-logs?from=2000-01-01&to=2000-01-02"))).json();
    expect(none.total).toBe(0);
    expect((await auditGET(new NextRequest("http://localhost/api/audit-logs?from=bad"))).status).toBe(400);
  });
});
