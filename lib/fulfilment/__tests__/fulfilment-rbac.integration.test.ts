import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { POST as fulfilmentPOST } from "@/app/api/orders/[id]/fulfilment/route";
import { GET as waitingGET } from "@/app/api/orders/waiting-for-stock/route";
import type { SessionUser } from "@/lib/auth/types";
import { sessionUserFor } from "@/lib/courier/__tests__/helpers";
import type { WaitingForStock } from "@/lib/fulfilment/waiting";
import { prisma } from "@/lib/prisma";

// C5 — CLAUDE.md rules 5 and 6 on the new screens: the Waiting for stock
// list is scoped like the Orders list, carries no cost, and a fulfilment
// action can't touch an order the person can't see. Reads the seeded demo
// (prisma/seed.ts seedFulfilmentDemo); writes nothing.

const SE = "01711000004";
const OTHER_SE = "01711000008";
const PACKING = "01711000005";

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}

beforeEach(() => {
  session.current = null;
});

describe("fulfilment screens respect the role scope", () => {
  it("an executive's Waiting for stock list holds only their own orders, and no cost", async () => {
    const se = await sessionUserFor(SE);
    asSession(se);
    const res = await waitingGET(new NextRequest("http://localhost/api/orders/waiting-for-stock"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaitingForStock;
    const ids = body.orders.map((o) => o.orderId);
    expect(ids.length).toBeGreaterThan(0);
    const owners = await prisma.order.findMany({ where: { id: { in: ids } }, select: { createdById: true } });
    expect(owners.every((o) => o.createdById === se.id)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/cost|weightedAvg|unitCostSnapshot|profit|margin/i);

    // Another executive sees none of them.
    asSession(await sessionUserFor(OTHER_SE));
    const other = (await (await waitingGET(new NextRequest("http://localhost/api/orders/waiting-for-stock"))).json()) as WaitingForStock;
    expect(other.orders.filter((o) => ids.includes(o.orderId))).toEqual([]);

    // Packing holds no order view at all.
    asSession(await sessionUserFor(PACKING));
    expect((await waitingGET(new NextRequest("http://localhost/api/orders/waiting-for-stock"))).status).toBe(403);
  });

  it("a fulfilment action on another executive's order is a 404, before anything is read or written", async () => {
    const se = await sessionUserFor(SE);
    const order = await prisma.order.findFirstOrThrow({ where: { createdById: se.id, status: "CONFIRMED", fulfilmentStatus: "WAITING_FOR_STOCK" }, select: { id: true, updatedAt: true } });
    asSession(await sessionUserFor(OTHER_SE));
    const res = await fulfilmentPOST(new NextRequest(`http://localhost/api/orders/${order.id}/fulfilment`, { method: "POST", body: JSON.stringify({ action: "WAIT", reason: "Trying someone else's order" }) }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(res.status).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { updatedAt: true } })).updatedAt).toEqual(order.updatedAt);
  });
});
