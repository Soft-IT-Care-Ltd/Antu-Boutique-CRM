import { describe, expect, it } from "vitest";

import { can } from "@/lib/auth/permissions";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import type { SessionUser } from "@/lib/auth/types";
import { prisma } from "@/lib/prisma";
import { getLowStockAlerts, getStockReport } from "@/lib/inventory/stock-report";
import { LEDGER_VIEW_PERMISSIONS, PURCHASE_VIEW_PERMISSIONS, getPurchaseDetail, listStockMovements } from "@/lib/inventory/queries";

// CLAUDE.md DoD: "log in as a Sales Executive — no cost, no profit …
// anywhere, including raw API responses". Requires `npm run db:seed`.

async function sessionUserFor(phone: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true, teamId: true, role: { select: { name: true } } } });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

const COST_KEYS = ["weightedAvgCost", "valueAtCost", "unitCostSnapshot", "unitCost", "landedUnitCost", "allocatedCost", "wacBefore", "wacAfter", "totalCost"];

function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

describe("inventory permissions (PRD §4.3)", () => {
  it("only ADMIN/MANAGER can adjust stock, see the ledger or see purchases", async () => {
    const byRole = {
      admin: await sessionUserFor("01711000001"),
      manager: await sessionUserFor("01711000002"),
      teamLeader: await sessionUserFor("01711000003"),
      se: await sessionUserFor("01711000004"),
      packing: await sessionUserFor("01711000005"),
      accounts: await sessionUserFor("01711000006"),
      pos: await sessionUserFor("01711000007"),
    };

    for (const [role, user] of Object.entries(byRole)) {
      const trusted = role === "admin" || role === "manager";
      expect(await can(user, "inventory.adjust"), `${role} inventory.adjust`).toBe(trusted);
      expect(await can(user, LEDGER_VIEW_PERMISSIONS), `${role} ledger`).toBe(trusted);
      expect(await can(user, PURCHASE_VIEW_PERMISSIONS, "all"), `${role} purchases`).toBe(trusted);
    }

    // Stock-on-hand is for everyone who sells or packs.
    for (const role of ["se", "teamLeader", "packing", "pos"] as const) {
      expect(await can(byRole[role], "inventory.view"), `${role} inventory.view`).toBe(true);
    }
  }, 60_000);
});

describe("a SALES_EXECUTIVE never gets inventory cost data", () => {
  it("the stock report response has no cost or valuation field anywhere", async () => {
    const se = await sessionUserFor("01711000004");
    const report = await getStockReport({ status: "all", page: 1, pageSize: 100 });
    expect(report.items.length).toBeGreaterThan(0);
    // Sanity: the unstripped report really does carry cost, so the strip below is doing the work.
    expect(keysDeep(report).has("weightedAvgCost")).toBe(true);
    expect(keysDeep(report).has("valueAtCost")).toBe(true);

    const body = await stripCostFieldsForUser({ ...report, page: 1, pageSize: 100 }, se);
    const keys = keysDeep(body);
    for (const key of COST_KEYS) expect(keys.has(key), key).toBe(false);
    // …while the stock numbers an SE needs are still there.
    expect(body.items[0]).toHaveProperty("available");
    expect(body.totals).toHaveProperty("onHand");
  }, 30_000);

  it("the low-stock alerts carry no cost field", async () => {
    const se = await sessionUserFor("01711000004");
    const body = await stripCostFieldsForUser({ alerts: await getLowStockAlerts() }, se);
    const keys = keysDeep(body);
    for (const key of COST_KEYS) expect(keys.has(key), key).toBe(false);
  });

  it("even if a ledger or purchase body leaked to an SE, the strip removes every cost field", async () => {
    const se = await sessionUserFor("01711000004");
    const movements = await listStockMovements({ page: 1, pageSize: 20 });
    const purchase = await prisma.purchase.findFirst({ select: { id: true } });
    const detail = purchase ? await getPurchaseDetail(purchase.id) : null;

    const keys = keysDeep(await stripCostFieldsForUser({ movements, detail }, se));
    for (const key of [...COST_KEYS, "itemsSubtotal", "transportCost", "otherCost", "lineCost"]) expect(keys.has(key), key).toBe(false);
  }, 30_000);
});

describe("low-stock roll-up on seeded data", () => {
  it("rolls Embroidered Kurti's low variants up into one product alert", async () => {
    const alerts = await getLowStockAlerts();
    const kurti = alerts.find((a) => a.productCode === "K12");
    expect(kurti).toBeDefined();
    expect(kurti!.lowVariants.length).toBeGreaterThan(0);
    expect(kurti!.message.length).toBeGreaterThan(0);
  });
});
