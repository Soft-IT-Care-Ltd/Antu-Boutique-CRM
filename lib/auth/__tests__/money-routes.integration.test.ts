import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers call auth(); next-auth can't load under plain Node, so the
// session is whatever the test says it is.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));
// Nothing here may reach Steadfast, even if a guard were missing.
vi.mock("@/lib/courier/steadfast/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/courier/steadfast/client")>();
  const refuse = vi.fn(async () => {
    throw new Error("A route under test tried to call Steadfast");
  });
  return { ...actual, getBalance: refuse, createOrder: refuse, createBulkOrder: refuse, statusByCid: refuse, statusByInvoice: refuse, getPayments: refuse, getPaymentDetail: refuse };
});

import { sessionUserFor } from "@/lib/courier/__tests__/helpers";
import { prisma } from "@/lib/prisma";

// Verify Phase 2, item 10 (PRD §3, §4.12 "Admin/Manager only. Not visible
// to SE, TL, Packing"). Every handler of every courier, wallet, expense,
// payment, payout and report route — found on disk, so a route added later
// is covered without editing this file — is called as a Sales Executive, a
// Team Leader and Packing. They get 403/404, except for the few routes the
// PRD gives them on purpose (below), whose responses must carry no money or
// cost field anywhere in the JSON.

const ROOT = path.resolve(__dirname, "../../..");
const SCANNED = ["app/api/courier", "app/api/couriers", "app/api/wallets", "app/api/expenses", "app/api/payments", "app/api/reports", "app/api/orders/[id]/payments", "app/api/orders/[id]/refunds"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Deliberate exceptions, by route → roles:
 * - /api/couriers is the order form's courier + zone picker. SE/TL quote the
 *   customer's delivery charge from it (a selling price, not a cost).
 * - PRD §3/§4.8: Packing hands parcels to the courier and condition-checks
 *   returns — it sees the shipment list, the send preview and the returns
 *   queue, with no money in them.
 */
const ALLOWED: Record<string, string[]> = {
  "GET /api/couriers": ["SALES_EXECUTIVE", "TEAM_LEADER"],
  "GET /api/courier/shipments": ["PACKING"],
  "GET /api/courier/returns": ["PACKING"],
  "POST /api/courier/steadfast/preview": ["PACKING"],
  "POST /api/courier/steadfast/send": ["PACKING"],
  "POST /api/courier/returns/[id]/check": ["PACKING"],
  "POST /api/courier/returns/[id]/kept-items": ["PACKING"],
};

/** Money and cost, by key name anywhere in a response tree. */
const MONEY_KEYS = new Set([
  "amount", "total", "subtotal", "dueAmount", "discountTotal", "unitPrice", "lineTotal", "lineDiscount", "payments", "transactionId",
  "codAmount", "codCollected", "cod", "deliveryCharge", "codCharge", "netAmount", "grossAmount", "expectedNet", "netReceivable",
  "balance", "openingBalance", "moneyIn", "moneyOut", "closingBalance",
  "cost", "unitCost", "unitCostSnapshot", "weightedAvgCost", "courierCostEstimate", "courierCostActual", "baseRate", "perKgRate",
  "returnCharge", "codChargePercent", "lastBalance", "profit", "margin", "valueAtCost",
]);
/** The picker's zone `charge` is the customer's delivery price — allowed there, and only there. */
const PICKER_KEYS = new Set(["couriers", "id", "name", "zones", "zone", "charge"]);

function routeFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs).flatMap((entry) => {
    const full = path.join(abs, entry);
    if (statSync(full).isDirectory()) return routeFiles(path.join(dir, entry));
    return entry === "route.ts" ? [path.join(dir, entry)] : [];
  });
}

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

/** Money keys in a response. A numeric `total` beside `items` at the top is the list's row count, not money. */
function moneyKeysIn(body: unknown): string[] {
  let tree = body;
  if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as { total?: unknown }).total === "number" && "items" in body) {
    tree = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "total"));
  }
  return [...keysOf(tree)].filter((k) => MONEY_KEYS.has(k));
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routes = [...new Set(SCANNED.flatMap(routeFiles))].sort();

beforeEach(() => {
  session.current = null;
});

describe("10. SE, TL and Packing: every courier / wallet / expense / payment / payout / report route", () => {
  it("finds the routes it is meant to sweep", () => {
    expect(routes.length).toBeGreaterThanOrEqual(35);
    for (const expected of ["app/api/wallets/route.ts", "app/api/expenses/route.ts", "app/api/courier/steadfast/payouts/sync/route.ts", "app/api/courier/statements/route.ts", "app/api/reports/expenses/route.ts"]) {
      expect(routes).toContain(expected);
    }
  });

  for (const role of ["SALES_EXECUTIVE", "TEAM_LEADER", "PACKING"] as const) {
    it(`${role}: 403/404, or — where the PRD allows it — a response with no money or cost field`, async () => {
      const phone = { SALES_EXECUTIVE: "01711000004", TEAM_LEADER: "01711000003", PACKING: "01711000005" }[role];
      const user = await sessionUserFor(phone);
      expect(user.role).toBe(role);
      session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };

      const calls: string[] = [];
      for (const file of routes) {
        const mod = (await import(path.join(ROOT, file))) as Partial<Record<(typeof METHODS)[number], Handler>>;
        const urlPath = "/" + path.dirname(file).replace(/^app\//, "");
        const params = Object.fromEntries([...urlPath.matchAll(/\[(\w+)\]/g)].map((m) => [m[1], "does-not-exist"]));
        const concrete = urlPath.replace(/\[(\w+)\]/g, "does-not-exist");

        for (const method of METHODS) {
          const handler = mod[method];
          if (!handler) continue;
          const key = `${method} ${urlPath}`;
          calls.push(key);
          const req = new NextRequest(`http://localhost${concrete}`, method === "GET" ? { method } : { method, body: "{}", headers: { "content-type": "application/json" } });
          const res = await handler(req, { params: Promise.resolve(params) });
          const allowed = ALLOWED[key]?.includes(role) ?? false;

          if (!allowed) {
            expect([401, 403, 404], `${role} ${key} → ${res.status}`).toContain(res.status);
            continue;
          }
          // Allowed: whatever it answers (200, or 400/404 for the dummy input) must hold no money.
          expect(res.status, `${role} ${key}`).toBeLessThan(500);
          const body = await res.json().catch(() => null);
          const leaked = moneyKeysIn(body);
          expect(leaked, `${role} ${key} leaked ${leaked.join(", ")}`).toEqual([]);
          if (key === "GET /api/couriers") {
            expect([...keysOf(body)].filter((k) => !PICKER_KEYS.has(k)), key).toEqual([]);
          }
        }
      }
      expect(calls.length).toBeGreaterThan(40);
    }, 180_000);
  }

  it("Packing with real data: shipment lists and the send preview carry no COD, due or courier cost", async () => {
    const packer = await sessionUserFor("01711000005");
    session.current = { user: { id: packer.id, role: packer.role, teamId: packer.teamId } };
    const { GET } = await import("@/app/api/courier/shipments/route");
    for (const tab of ["ready", "in_transit", "delivered", "returned", "all"]) {
      const res = await GET(new NextRequest(`http://localhost/api/courier/shipments?tab=${tab}`));
      if (res.status === 400) continue; // a tab name this build doesn't have
      expect(res.status, tab).toBe(200);
      const leaked = moneyKeysIn(await res.json());
      expect(leaked, `tab ${tab}`).toEqual([]);
    }

    // The send preview for real PACKED orders (the rider's COD is Accounts' business, not Packing's).
    const packed = await prisma.order.findMany({ where: { status: "PACKED", deletedAt: null }, select: { id: true }, take: 5 });
    expect(packed.length).toBeGreaterThan(0);
    const { POST } = await import("@/app/api/courier/steadfast/preview/route");
    const res = await POST(new NextRequest("http://localhost/api/courier/steadfast/preview", { method: "POST", body: JSON.stringify({ orderIds: packed.map((o) => o.id) }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(moneyKeysIn(body)).toEqual([]);
  }, 60_000);
});

describe("3. courier credentials: encrypted at rest, never in an API response", () => {
  it("Admin saves keys → the DB holds ciphertext; neither the save nor the read returns the keys; Packing/SE can't read settings", async () => {
    const { GET, PUT } = await import("@/app/api/courier/steadfast/settings/route");
    const { decryptSecret } = await import("@/lib/courier/crypto");
    const saved = await prisma.courierIntegration.findUnique({ where: { provider: "STEADFAST" } });
    const apiKey = "plain-API-key-7f3a9c1e5b";
    const secretKey = "plain-SECRET-key-2d8e4f6a0c";
    const url = "http://localhost/api/courier/steadfast/settings";
    try {
      const admin = await sessionUserFor("01711000001");
      session.current = { user: { id: admin.id, role: admin.role, teamId: admin.teamId } };
      const put = await PUT(new NextRequest(url, { method: "PUT", body: JSON.stringify({ apiKey, secretKey }), headers: { "content-type": "application/json" } }));
      expect(put.status).toBe(200);
      const got = await GET(new NextRequest(url));
      for (const text of [await put.text(), await got.text()]) {
        expect(text).not.toContain(apiKey);
        expect(text).not.toContain(secretKey);
        expect(text).not.toMatch(/Encrypted/);
      }

      const row = await prisma.courierIntegration.findUniqueOrThrow({ where: { provider: "STEADFAST" } });
      expect(row.apiKeyEncrypted).not.toContain(apiKey);
      expect(row.secretKeyEncrypted).not.toContain(secretKey);
      expect(decryptSecret(row.apiKeyEncrypted!)).toBe(apiKey);

      for (const phone of ["01711000004", "01711000005", "01711000006"]) {
        const u = await sessionUserFor(phone);
        session.current = { user: { id: u.id, role: u.role, teamId: u.teamId } };
        expect((await GET(new NextRequest(url))).status, u.role).toBe(403);
      }
    } finally {
      if (saved) {
        const { apiKeyEncrypted, secretKeyEncrypted, connectedAt, lastBalance, lastBalanceAt } = saved;
        await prisma.courierIntegration.update({ where: { provider: "STEADFAST" }, data: { apiKeyEncrypted, secretKeyEncrypted, connectedAt, lastBalance, lastBalanceAt } });
      } else {
        await prisma.courierIntegration.deleteMany({ where: { provider: "STEADFAST" } });
      }
    }
  }, 60_000);
});
