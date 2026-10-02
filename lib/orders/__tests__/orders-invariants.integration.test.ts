import { describe, expect, it } from "vitest";

import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import type { SessionUser } from "@/lib/auth/types";
import { prisma } from "@/lib/prisma";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { computeDueAmount, computeOrderTotals } from "@/lib/orders/totals";

// Requires `npm run db:seed` to have run against DATABASE_URL first — same
// style as lib/customers/__tests__/customers-rbac.integration.test.ts.

async function sessionUserFor(phone: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { phone },
    select: { id: true, teamId: true, role: { select: { name: true } } },
  });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

describe("order totals and due_amount (CLAUDE.md rule 1)", () => {
  it("computes subtotal/discount/total from lines only, never from a stored field", () => {
    const totals = computeOrderTotals(
      [
        { qty: 2, unitPrice: 1500, lineDiscount: 100 },
        { qty: 1, unitPrice: 3500, lineDiscount: 0 },
      ],
      60,
    );
    expect(totals.subtotal).toBe(2 * 1500 + 3500);
    expect(totals.discountTotal).toBe(100);
    expect(totals.total).toBe(totals.subtotal - totals.discountTotal + 60);
  });

  it("due_amount is total minus payments received so far, and goes negative on overpayment rather than clamping", () => {
    expect(computeDueAmount(3560, 500)).toBe(3060);
    expect(computeDueAmount(3560, 3560)).toBe(0);
    expect(computeDueAmount(3560, 4000)).toBe(-440);
  });
});

describe("price floor (PRD §4.6 section 2)", () => {
  it("blocks a price below cost for a role without product.cost.view", () => {
    expect(isPriceBelowFloor(500, 700, false)).toBe(true);
    expect(isPriceBelowFloor(900, 700, false)).toBe(false);
  });

  it("never blocks Admin/Manager — they're trusted to knowingly sell below cost", () => {
    expect(isPriceBelowFloor(1, 700, true)).toBe(false);
  });
});

describe("order query scoping (CLAUDE.md rule 6)", () => {
  it("scopes a SALES_EXECUTIVE to only the orders they created", async () => {
    const seUser = await sessionUserFor("01711000004");
    const where = scopedWhere({ deletedAt: null }, seUser);

    const orders = await prisma.order.findMany({ where });
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) {
      expect(order.createdById).toBe(seUser.id);
    }

    const allOrders = await prisma.order.findMany({ where: { deletedAt: null } });
    expect(allOrders.length).toBeGreaterThan(orders.length);
  });

  it("a client-sent createdById filter can never widen an SE's scope (AND, not override)", async () => {
    const seUser = await sessionUserFor("01711000004");
    const otherUser = await prisma.user.findFirstOrThrow({ where: { id: { not: seUser.id } } });

    const where = scopedWhere({ deletedAt: null, createdById: otherUser.id }, seUser);
    const orders = await prisma.order.findMany({ where });
    expect(orders).toHaveLength(0);
  });
});

describe("order.create reserves stock at CONFIRMED (CLAUDE.md rule 10)", () => {
  it("the seeded confirmed order's variant shows a reservedQty covering its line qty", async () => {
    // The seed's first demo order (confirmed, advance taken). Found by what it
    // is, not by number: its number depends on the month the seed ran in.
    const order = await prisma.order.findFirstOrThrow({
      where: { status: "CONFIRMED", channel: "ONLINE", deletedAt: null, customer: { phone: "01911223344" } },
      orderBy: { createdAt: "asc" },
      include: { items: true },
    });
    expect(order.items.length).toBeGreaterThan(0);

    const item = order.items[0];
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: item.variantId } });
    expect(variant.reservedQty).toBeGreaterThanOrEqual(item.qty);
  });
});

describe("order detail never leaks cost to a SALES_EXECUTIVE", () => {
  it("strips unitCostSnapshot and weightedAvgCost-shaped fields from the serialized response", async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { status: "CONFIRMED", channel: "ONLINE", deletedAt: null, customer: { phone: "01911223344" } }, orderBy: { createdAt: "asc" } });
    const loaded = await loadOrderDetail(order.id);
    if (!loaded) throw new Error("seed's first demo order not found — run npm run db:seed");
    const serialized = serializeOrderDetail(loaded);

    const seUser = await sessionUserFor("01711000004");
    const adminUser = await sessionUserFor("01711000001");

    expect(await can(seUser, "product.cost.view")).toBe(false);
    expect(await can(adminUser, "product.cost.view")).toBe(true);

    const seBody = await stripCostFieldsForUser(serialized, seUser);
    const adminBody = await stripCostFieldsForUser(serialized, adminUser);

    expect(JSON.stringify(seBody)).not.toContain("unitCostSnapshot");
    // Non-cost order data survives the strip.
    expect(seBody.items[0]).toHaveProperty("sku");
    expect(seBody.items[0]).toHaveProperty("lineTotal");

    expect(JSON.stringify(adminBody)).toContain("unitCostSnapshot");
  });
});
