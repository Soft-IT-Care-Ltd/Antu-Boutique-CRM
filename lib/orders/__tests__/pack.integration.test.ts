import { describe, expect, it } from "vitest";

import { toNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { IllegalTransitionError, packOrder } from "@/lib/orders/pack";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// Requires `npm run db:seed` to have run against DATABASE_URL first — same
// style as lib/orders/__tests__/orders-invariants.integration.test.ts.

describe("packOrder (PRD §4.8, CLAUDE.md rules 2/3/10)", () => {
  // Runs inside a rolled-back transaction: packing now writes an
  // append-only SALE_OUT ledger row, which can't be deleted afterwards.
  it("freezes unit_cost_snapshot from the variant's current cost and deducts stock with a SALE_OUT ledger row, atomically", async () => {
    await inRolledBackTransaction(async (tx) => {
      const variant = await tx.productVariant.findFirstOrThrow({ where: { isActive: true, stockQty: { gt: 0 } } });
      const packer = await tx.user.findUniqueOrThrow({ where: { phone: "01711000005" } });
      const customer = await tx.customer.findFirstOrThrow({});

      const stockBefore = variant.stockQty;
      const reservedBefore = variant.reservedQty;
      const qty = 1;

      // Mirror what CONFIRMED already did to this variant in a real order.
      await tx.productVariant.update({ where: { id: variant.id }, data: { reservedQty: { increment: qty } } });

      const order = await tx.order.create({
        data: {
          orderNo: `TEST-PACK-${Date.now()}`,
          channel: "ONLINE",
          status: "CONFIRMED",
          customerId: customer.id,
          items: { create: [{ variantId: variant.id, qty, unitPrice: 0 }] },
        },
        include: { items: true },
      });

      await packOrder(
        tx,
        { id: order.id, status: "CONFIRMED", items: order.items.map((i) => ({ id: i.id, variantId: i.variantId, qty: i.qty })) },
        packer.id,
        "test pack",
      );

      const item = await tx.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } });
      expect(item.unitCostSnapshot).not.toBeNull();
      expect(toNumber(item.unitCostSnapshot!)).toBe(toNumber(variant.weightedAvgCost));

      const refreshedVariant = await tx.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
      expect(refreshedVariant.stockQty).toBe(stockBefore - qty);
      // reservedQty went CONFIRMED (+qty, done above) then PACKED (-qty) — net unchanged.
      expect(refreshedVariant.reservedQty).toBe(reservedBefore);

      const saleOut = await tx.stockMovement.findFirstOrThrow({ where: { referenceType: "ORDER", referenceId: order.id } });
      expect(saleOut).toMatchObject({ type: "SALE_OUT", qty: -qty, stockAfter: stockBefore - qty, actorId: packer.id });
      expect(toNumber(saleOut.unitCostSnapshot)).toBe(toNumber(variant.weightedAvgCost));
      await checkDeferredConstraintsNow(tx);

      const refreshedOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(refreshedOrder.status).toBe("PACKED");

      const history = await tx.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history.some((h) => h.toStatus === "PACKED" && h.fromStatus === "CONFIRMED")).toBe(true);
    });
  }, 60_000);

  it("rejects packing an order that isn't CONFIRMED or ON_HOLD, without touching the database", async () => {
    await expect(
      prisma.$transaction((tx) => packOrder(tx, { id: "nonexistent", status: "LEAD", items: [] }, "someone")),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});
