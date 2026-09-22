import { describe, expect, it } from "vitest";

import { toNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { IllegalTransitionError, packOrder } from "@/lib/orders/pack";

// Requires `npm run db:seed` to have run against DATABASE_URL first — same
// style as lib/orders/__tests__/orders-invariants.integration.test.ts.

describe("packOrder (PRD §4.8, CLAUDE.md rules 2/3/10)", () => {
  it("freezes unit_cost_snapshot from the variant's current cost and deducts stock atomically", async () => {
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { isActive: true } });
    const packer = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000005" } });
    const customer = await prisma.customer.findFirstOrThrow({});

    const stockBefore = variant.stockQty;
    const reservedBefore = variant.reservedQty;
    const qty = 1;

    // Mirror what CONFIRMED already did to this variant in a real order.
    await prisma.productVariant.update({ where: { id: variant.id }, data: { reservedQty: { increment: qty } } });

    const order = await prisma.order.create({
      data: {
        orderNo: `TEST-PACK-${Date.now()}`,
        channel: "ONLINE",
        status: "CONFIRMED",
        customerId: customer.id,
        items: { create: [{ variantId: variant.id, qty, unitPrice: 0 }] },
      },
      include: { items: true },
    });

    try {
      await prisma.$transaction((tx) =>
        packOrder(
          tx,
          { id: order.id, status: "CONFIRMED", items: order.items.map((i) => ({ id: i.id, variantId: i.variantId, qty: i.qty })) },
          packer.id,
          "test pack",
        ),
      );

      const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
      expect(item.unitCostSnapshot).not.toBeNull();
      expect(toNumber(item.unitCostSnapshot!)).toBe(toNumber(variant.weightedAvgCost));

      const refreshedVariant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      expect(refreshedVariant.stockQty).toBe(stockBefore - qty);
      // reservedQty went CONFIRMED (+qty, done above) then PACKED (-qty) — net unchanged.
      expect(refreshedVariant.reservedQty).toBe(reservedBefore);

      const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(refreshedOrder.status).toBe("PACKED");

      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history.some((h) => h.toStatus === "PACKED" && h.fromStatus === "CONFIRMED")).toBe(true);
    } finally {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: order.id } });
      await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
      await prisma.productVariant.update({ where: { id: variant.id }, data: { stockQty: stockBefore, reservedQty: reservedBefore } });
    }
  });

  it("rejects packing an order that isn't CONFIRMED or ON_HOLD, without touching the database", async () => {
    await expect(
      prisma.$transaction((tx) => packOrder(tx, { id: "nonexistent", status: "LEAD", items: [] }, "someone")),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});
