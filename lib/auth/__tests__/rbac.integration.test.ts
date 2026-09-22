import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { can, getEffectivePermissions } from "@/lib/auth/permissions";
import { stripCostFields } from "@/lib/auth/strip-cost-fields";
import type { SessionUser } from "@/lib/auth/types";

// Proves the RBAC chain end to end against the real seeded DB: a
// SALES_EXECUTIVE never holds product.cost.view, and a response body run
// through the field-stripping helper for that role contains no cost keys —
// the same helper every API route uses. Requires `npm run db:seed` to have
// been run against DATABASE_URL first.

describe("SALES_EXECUTIVE never gets cost data", () => {
  it("does not hold product.cost.view or report.pl.view", async () => {
    const seUser = await prisma.user.findUniqueOrThrow({
      where: { phone: "01711000004" },
      select: { id: true, teamId: true, role: { select: { name: true } } },
    });

    const sessionUser: SessionUser = { id: seUser.id, role: seUser.role.name, teamId: seUser.teamId };

    expect(seUser.role.name).toBe("SALES_EXECUTIVE");

    const permissions = await getEffectivePermissions(sessionUser.id);
    expect(permissions.has("product.cost.view")).toBe(false);
    expect(permissions.has("report.pl.view")).toBe(false);

    await expect(can(sessionUser, "product.cost.view")).resolves.toBe(false);
  });

  it("strips cost fields from a simulated API response body for this user", async () => {
    const seUser = await prisma.user.findUniqueOrThrow({
      where: { phone: "01711000004" },
      select: { id: true, teamId: true, role: { select: { name: true } } },
    });
    const sessionUser: SessionUser = { id: seUser.id, role: seUser.role.name, teamId: seUser.teamId };

    const apiResponseBody = {
      variants: [
        { id: "v1", sku: "PRD-1-M-BLACK", stockQty: 8, weightedAvgCost: 610, priceOverride: 1450 },
        { id: "v2", sku: "PRD-1-L-BLACK", stockQty: 3, weightedAvgCost: 610, priceOverride: 1450 },
      ],
      summary: { totalCost: 4880, totalProfit: 1520, margin: 0.31 },
    };

    const hasCostAccess = await can(sessionUser, "product.cost.view");
    const stripped = stripCostFields(apiResponseBody, hasCostAccess);
    const serialized = JSON.stringify(stripped);

    expect(hasCostAccess).toBe(false);
    for (const forbidden of ["weightedAvgCost", "totalCost", "totalProfit", "margin"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Non-cost data still made it through.
    expect(serialized).toContain("PRD-1-M-BLACK");
  });
});
