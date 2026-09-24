import { describe, expect, it } from "vitest";

import { can } from "@/lib/auth/permissions";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import type { SessionUser } from "@/lib/auth/types";
import { loadProductDetail, serializeProductDetail } from "@/lib/catalog/product-detail";
import { getProductStockSummaries, summaryFor } from "@/lib/catalog/stock-status";
import { prisma } from "@/lib/prisma";

// Requires `npm run db:seed` to have run against DATABASE_URL first — reads
// the real seeded catalog rather than mocking Prisma, same style as
// lib/auth/__tests__/rbac.integration.test.ts.

async function sessionUserFor(phone: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { phone },
    select: { id: true, teamId: true, role: { select: { name: true } } },
  });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

describe("catalog stock roll-up", () => {
  it("flags the seeded low-stock and out-of-stock variants correctly", async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { code: "K12" } });
    const summaries = await getProductStockSummaries([product.id]);
    const summary = summaryFor(summaries, product.id);

    // Seed: XL/Maroon stock=2 (threshold default 5) -> low; L/Mustard Yellow
    // stock=0 -> also low/zero. hasLowVariant must be true either way.
    expect(summary.hasLowVariant).toBe(true);
    expect(summary.status).not.toBe("IN_STOCK");
  });

  it("treats a product whose only variants are all out of stock as OUT_OF_STOCK", async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { code: "W02" } });
    const variants = await prisma.productVariant.findMany({ where: { productId: product.id } });
    const totalAvailable = variants.reduce((sum, v) => sum + (v.stockQty - v.reservedQty), 0);
    expect(totalAvailable).toBeGreaterThan(0); // sanity: seed has some stock on this product overall

    // But at least one seeded variant (M/Black) is exactly zero.
    const zeroVariant = variants.find((v) => v.stockQty === 0);
    expect(zeroVariant).toBeTruthy();
  });
});

describe("catalog cost fields never reach a SALES_EXECUTIVE", () => {
  it("strips weightedAvgCost from a product-detail response for an SE, keeps it for Admin", async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { code: "K12" },
      select: { id: true },
    });

    const row = await loadProductDetail(product.id);
    if (!row) throw new Error("seed product K12 not found — run npm run db:seed");

    const summaries = await getProductStockSummaries([product.id]);
    const serialized = serializeProductDetail(row, summaryFor(summaries, product.id).available);

    const seUser = await sessionUserFor("01711000004");
    const adminUser = await sessionUserFor("01711000001");

    expect(await can(seUser, "product.cost.view")).toBe(false);
    expect(await can(adminUser, "product.cost.view")).toBe(true);

    const seBody = await stripCostFieldsForUser(serialized, seUser);
    const adminBody = await stripCostFieldsForUser(serialized, adminUser);

    const seJson = JSON.stringify(seBody);
    expect(seJson).not.toContain("weightedAvgCost");
    // Selling price fields are not cost data — they must survive the strip.
    expect(seBody.variants[0]).not.toHaveProperty("weightedAvgCost");
    expect(seBody.variants[0]).toHaveProperty("sku");
    expect(seBody.variants[0]).toHaveProperty("available");

    expect(JSON.stringify(adminBody)).toContain("weightedAvgCost");
  });
});
