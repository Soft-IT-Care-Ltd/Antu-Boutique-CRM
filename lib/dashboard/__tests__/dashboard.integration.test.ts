import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));
vi.mock("@/lib/courier/steadfast/client");

import { GET as ordersGET } from "@/app/api/orders/route";
import { GET as packingGET } from "@/app/api/packing/queue/route";
import type { SessionUser } from "@/lib/auth/types";
import { makePackedOrder, sessionUserFor } from "@/lib/courier/__tests__/helpers";
import { ordersHref } from "@/lib/dashboard/links";
import { getPackingNumbers } from "@/lib/dashboard/operations";
import { getOwnerNumbers } from "@/lib/dashboard/owner";
import { dashboardPanels } from "@/lib/dashboard/panels";
import { getSalesNumbers } from "@/lib/dashboard/sales";
import { getProfitReport } from "@/lib/finance/profit";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { toPaisa } from "@/lib/inventory/costing";
import { PACKING_VIEWS } from "@/lib/packing/types";
import { prisma } from "@/lib/prisma";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// P4.3 (PRD §4.16) — every dashboard number is the list it links to, run
// through the real list route as the same user; the sales dashboard holds
// only the viewer's own (or team's) orders; profit follows the §4.12 rule.
// Reads the seeded demo data; the one write runs in a rolled-back transaction.

const ADMIN = "01711000001";
const MANAGER = "01711000002";
const TL = "01711000003";
const SE = "01711000004";
const PACKING = "01711000005";
const ACCOUNTS = "01711000006";
const POS = "01711000007";

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}

/** Opens a dashboard link through the order list route, as the signed-in user. */
async function listFor(href: string): Promise<{ total: number; totalValue: number; totalDue: number }> {
  const url = new URL(href, "http://localhost");
  url.pathname = "/api/orders";
  url.searchParams.set("pageSize", "1");
  const res = await ordersGET(new NextRequest(url));
  expect(res.status).toBe(200);
  const body = await res.json();
  return { total: body.total, totalValue: Number(body.totalValue), totalDue: Number(body.totalDue) };
}

beforeEach(() => {
  session.current = null;
});

describe("which dashboard each role gets (by permission)", () => {
  it("maps the seeded roles onto the PRD §4.16 dashboards", async () => {
    const got: Record<string, string[]> = {};
    for (const [name, phone] of Object.entries({ ADMIN, MANAGER, TL, SE, PACKING, ACCOUNTS, POS })) {
      const p = await dashboardPanels(await sessionUserFor(phone));
      got[name] = (["owner", "sales", "packing", "accounts", "counter"] as const).filter((k) => p[k]);
    }
    expect(got).toEqual({ ADMIN: ["owner"], MANAGER: ["owner"], TL: ["sales"], SE: ["sales"], PACKING: ["packing"], ACCOUNTS: ["accounts"], POS: ["counter"] });
  });
});

describe("every number is the list it links to", () => {
  it("owner: today, month to date, funnel and stuck orders match the order list", async () => {
    const admin = await sessionUserFor(ADMIN);
    asSession(admin);
    const n = await getOwnerNumbers(prisma, admin);
    const r = n.ranges;
    for (const [row, range] of [
      [n.today, r.todayRange],
      [n.inPeriod, r.mtdRange],
    ] as const) {
      const sales = await listFor(ordersHref({ preset: "sales", range }));
      expect([sales.total, sales.totalValue]).toEqual([row.orders, Number(row.value)]);
      expect((await listFor(ordersHref({ preset: "due", range }))).totalDue).toBe(Number(row.due));
    }
    expect((await listFor(ordersHref({ status: "CONFIRMED" }))).total).toBe(n.funnel.confirmed);
    expect((await listFor(ordersHref({ status: "PACKED" }))).total).toBe(n.funnel.packed);
    expect((await listFor(ordersHref({ preset: "in_transit" }))).total).toBe(n.funnel.inTransit);
    expect((await listFor(ordersHref({ dateBy: "delivered", range: r.todayRange }))).total).toBe(n.funnel.deliveredToday);
    expect((await listFor(ordersHref({ preset: "stuck" }))).total).toBe(n.stuck.reduce((a, s) => a + s.count, 0));
    // A day's sales bar opens that day's orders.
    const busiest = [...n.days].sort((a, b) => b.orders - a.orders)[0];
    const day = await listFor(ordersHref({ preset: "sales", range: { from: busiest.day, to: busiest.day } }));
    expect([day.total, day.totalValue]).toEqual([busiest.orders, busiest.online + busiest.walkIn]);
  });

  it("an executive's dashboard is their own orders only, with nothing cost-shaped in it", async () => {
    const se = await sessionUserFor(SE);
    asSession(se);
    const n = await getSalesNumbers(prisma, se);
    const list = await listFor(ordersHref({ preset: "sales", range: n.ranges.mtdRange }));
    expect([list.total, list.totalValue]).toEqual([n.inPeriod.orders, Number(n.inPeriod.value)]);

    const own = await prisma.order.aggregate({
      where: { createdById: se.id, deletedAt: null, exchangedFromOrderId: null, status: { notIn: ["LEAD", "CANCELLED", "RETURNED", "REFUNDED"] }, createdAt: { gte: dhakaDayStartUtc(n.ranges.monthStart) } },
      _sum: { total: true },
      _count: { _all: true },
    });
    expect([n.inPeriod.orders, toPaisa(n.inPeriod.value)]).toEqual([own._count._all, toPaisa(own._sum.total ?? 0)]);
    expect(n.inPeriod.orders).toBeGreaterThan(0);
    for (const s of n.openOrders) expect((await listFor(ordersHref({ status: s.status }))).total).toBe(s.count);
    expect(JSON.stringify(n)).not.toMatch(/cost|profit|margin/i);
  });

  it("a team leader's is the team's", async () => {
    const tl = await sessionUserFor(TL);
    asSession(tl);
    const n = await getSalesNumbers(prisma, tl);
    const team = await prisma.order.count({
      where: { teamId: tl.teamId, deletedAt: null, exchangedFromOrderId: null, status: { notIn: ["LEAD", "CANCELLED", "RETURNED", "REFUNDED"] }, createdAt: { gte: dhakaDayStartUtc(n.ranges.monthStart) } },
    });
    expect(n.inPeriod.orders).toBe(team);
    expect((await listFor(ordersHref({ preset: "sales", range: n.ranges.mtdRange }))).total).toBe(team);
  });

  it("packing: each count is its packing view", async () => {
    const packer = await sessionUserFor(PACKING);
    asSession(packer);
    const { counts } = await getPackingNumbers(prisma);
    for (const view of PACKING_VIEWS) {
      const res = await packingGET(new NextRequest(`http://localhost/api/packing/queue?view=${view}&pageSize=1`));
      const body = await res.json();
      expect([view, body.total]).toEqual([view, counts[view]]);
      expect(JSON.stringify(body)).not.toMatch(/"(total|dueAmount|unitPrice|subtotal)"\s*:\s*"/);
    }
  });

  it("packing can't read the order list the owner's figures link to", async () => {
    asSession(await sessionUserFor(PACKING));
    expect((await ordersGET(new NextRequest("http://localhost/api/orders?preset=sales"))).status).toBe(403);
  });
});

describe("profit (PRD §4.12 rule)", () => {
  it("counts an order on the day it's packed — its total less the frozen cost — less operating expenses, never supplier payments", async () => {
    await inRolledBackTransaction(async (tx) => {
      const today = todayInDhaka();
      const from = dhakaDayStartUtc(today);
      const to = dhakaDayStartUtc(today, 1);
      const before = await getProfitReport(tx, from, to);

      const { order } = await makePackedOrder(tx, { lines: 2, qty: 2 });
      const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const cogs = items.reduce((a, i) => a + i.qty * toPaisa(i.unitCostSnapshot!), 0);
      const afterPack = await getProfitReport(tx, from, to);
      expect(afterPack.totals.revenuePaisa - before.totals.revenuePaisa).toBe(toPaisa(order.total));
      expect(afterPack.totals.cogsPaisa - before.totals.cogsPaisa).toBe(cogs);
      expect(afterPack.orders.some((o) => o.id === order.id)).toBe(true);

      const wallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
      const [misc, purchase] = await Promise.all([tx.expenseCategory.findFirstOrThrow({ where: { kind: "MISC", isSystem: false } }), tx.expenseCategory.findFirstOrThrow({ where: { kind: "PURCHASE" } })]);
      await tx.expense.create({ data: { expenseDate: from, categoryId: misc.id, nature: "VARIABLE", amount: 123, walletId: wallet.id } });
      await tx.expense.create({ data: { expenseDate: from, categoryId: purchase.id, nature: "VARIABLE", amount: 5000, walletId: wallet.id } });
      const afterExpenses = await getProfitReport(tx, from, to);
      expect(afterExpenses.totals.expensesPaisa - afterPack.totals.expensesPaisa).toBe(12_300);

      // Cancelled after packing: it no longer carries revenue or cost.
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
      const afterCancel = await getProfitReport(tx, from, to);
      expect(afterCancel.totals.revenuePaisa).toBe(before.totals.revenuePaisa);
      expect(afterCancel.totals.cogsPaisa).toBe(before.totals.cogsPaisa);
    });
  });
});
