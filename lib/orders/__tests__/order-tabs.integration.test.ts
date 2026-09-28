import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { GET as ordersGET } from "@/app/api/orders/route";
import { GET as tabCountsGET } from "@/app/api/orders/tab-counts/route";
import type { SessionUser } from "@/lib/auth/types";
import { sessionUserFor } from "@/lib/courier/__tests__/helpers";
import { resolveDateRange } from "@/lib/date-range";
import { ORDER_TABS, type OrderTabCounts } from "@/lib/orders/tabs";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 14 — each Orders tab's count is exactly the rows it
// lists, for each role's scope; open-work tabs ignore the date filter,
// finished tabs follow it; nothing is hidden from every tab. Reads the
// seeded demo data only.

const ADMIN = "01711000001";
const SE = "01711000004";

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}

async function get<T>(handler: (r: NextRequest) => Promise<Response>, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, "http://localhost");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await handler(new NextRequest(url));
  expect(res.status, `${path}?${url.searchParams}`).toBe(200);
  return (await res.json()) as T;
}

const listTotal = async (params: Record<string, string>) => (await get<{ total: number }>(ordersGET, "/api/orders", { ...params, pageSize: "25" })).total;

beforeEach(() => {
  session.current = null;
});

describe("Orders tabs", () => {
  for (const [who, phone] of [
    ["admin", ADMIN],
    ["sales executive", SE],
  ] as const) {
    it(`${who}: every tab and sub-tab count is its list's total, with and without dates`, async () => {
      const user = await sessionUserFor(phone);
      asSession(user);
      const month = resolveDateRange({ preset: "this_month" }) as Record<string, string>;
      for (const filters of [{}, month]) {
        const counts = await get<OrderTabCounts>(tabCountsGET, "/api/orders/tab-counts", filters);
        for (const t of ORDER_TABS) {
          expect(await listTotal({ ...filters, tab: t.key }), `${t.key} ${JSON.stringify(filters)}`).toBe(counts.tabs[t.key]);
          for (const s of t.subTabs ?? []) expect(await listTotal({ ...filters, tab: t.key, sub: s.key }), `${t.key}/${s.key}`).toBe(counts.subTabs[s.key]);
        }
      }
    });
  }

  it("open work ignores the dates, and the all-time All tab holds every order the user can see", async () => {
    const admin = await sessionUserFor(ADMIN);
    asSession(admin);
    // A range with nothing in it: open tabs keep their orders, finished tabs empty out.
    const empty = { from: "2000-01-01", to: "2000-01-02" };
    const withDates = await get<OrderTabCounts>(tabCountsGET, "/api/orders/tab-counts", empty);
    const noDates = await get<OrderTabCounts>(tabCountsGET, "/api/orders/tab-counts", {});
    for (const t of ORDER_TABS) expect(withDates.tabs[t.key], t.key).toBe(t.open ? noDates.tabs[t.key] : 0);
    expect(noDates.tabs.all).toBe(await prisma.order.count({ where: { deletedAt: null } }));
  });

  it("a sales executive's tabs only ever count their own orders", async () => {
    const se = await sessionUserFor(SE);
    asSession(se);
    const counts = await get<OrderTabCounts>(tabCountsGET, "/api/orders/tab-counts", {});
    expect(counts.tabs.all).toBe(await prisma.order.count({ where: { deletedAt: null, createdById: se.id } }));
    // Naming another person narrows to nothing rather than widening (rule 6).
    const other = await prisma.user.findFirstOrThrow({ where: { phone: ADMIN } });
    const narrowed = await get<OrderTabCounts>(tabCountsGET, "/api/orders/tab-counts", { createdById: other.id });
    expect(narrowed.tabs.all).toBe(0);
  });
});
