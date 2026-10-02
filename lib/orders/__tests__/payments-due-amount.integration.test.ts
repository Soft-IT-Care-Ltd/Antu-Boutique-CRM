import { describe, expect, it } from "vitest";

import { toNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { createPaymentSchema, updatePaymentSchema } from "@/lib/orders/payment-validation";
import { COUNTED_PAYMENTS_WHERE, recomputeOrderDueAmount } from "@/lib/orders/totals";

// Requires `npm run db:seed` to have run against DATABASE_URL first — same
// style as lib/orders/__tests__/orders-invariants.integration.test.ts.

describe("a client-sent due_amount can never reach a payment write (CLAUDE.md rule 1)", () => {
  it("createPaymentSchema silently drops a dueAmount field from the request body", () => {
    const parsed = createPaymentSchema.parse({
      amount: 500,
      method: "CASH",
      dueAmount: -999999,
      due_amount: -999999,
    });
    expect(parsed).not.toHaveProperty("dueAmount");
    expect(parsed).not.toHaveProperty("due_amount");
    expect(Object.keys(parsed).sort()).toEqual(["amount", "method"]);
  });

  it("updatePaymentSchema silently drops a dueAmount field from the request body", () => {
    const parsed = updatePaymentSchema.parse({ amount: 250, dueAmount: 1 });
    expect(parsed).not.toHaveProperty("dueAmount");
  });
});

describe("recomputeOrderDueAmount is the only writer of order.due_amount (CLAUDE.md rule 1)", () => {
  it("overwrites any value already stored on the order with total - sum(payments)", async () => {
    // A seeded online order with money on it, found by what it is (its number
    // depends on the month the seed ran in). Only payments that count toward
    // due are summed — a pending refund doesn't (lib/orders/totals.ts).
    const order = await prisma.order.findFirstOrThrow({
      where: { channel: "ONLINE", deletedAt: null, payments: { some: {} } },
      orderBy: { createdAt: "asc" },
      include: { payments: { where: COUNTED_PAYMENTS_WHERE, select: { amount: true } } },
    });
    const total = toNumber(order.total);
    const paidBefore = order.payments.reduce((sum, p) => sum + toNumber(p.amount), 0);
    const expectedDueBefore = total - paidBefore;

    let createdPaymentId: string | null = null;
    try {
      // Simulate a stored due_amount a client tried to smuggle through by
      // some other path — recomputeOrderDueAmount must ignore it entirely
      // and derive the truth fresh from total and payments every time.
      await prisma.order.update({ where: { id: order.id }, data: { dueAmount: -999999 } });

      const payment = await prisma.payment.create({
        data: { orderId: order.id, amount: 1000, method: "CASH", verified: false },
      });
      createdPaymentId = payment.id;

      const newDue = await prisma.$transaction((tx) => recomputeOrderDueAmount(tx, order.id));
      expect(newDue).toBe(expectedDueBefore - 1000);
      expect(newDue).not.toBe(-999999);

      const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(toNumber(refreshed.dueAmount)).toBe(expectedDueBefore - 1000);
    } finally {
      if (createdPaymentId) await prisma.payment.delete({ where: { id: createdPaymentId } }).catch(() => {});
      await prisma.$transaction((tx) => recomputeOrderDueAmount(tx, order.id));
    }

    const restored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(toNumber(restored.dueAmount)).toBe(expectedDueBefore);
  });

  it("recomputes back down when a payment is deleted", async () => {
    // A seeded online order with money on it, found by what it is (its number
    // depends on the month the seed ran in). Only payments that count toward
    // due are summed — a pending refund doesn't (lib/orders/totals.ts).
    const order = await prisma.order.findFirstOrThrow({
      where: { channel: "ONLINE", deletedAt: null, payments: { some: {} } },
      orderBy: { createdAt: "asc" },
      include: { payments: { where: COUNTED_PAYMENTS_WHERE, select: { amount: true } } },
    });
    const total = toNumber(order.total);
    const paidBefore = order.payments.reduce((sum, p) => sum + toNumber(p.amount), 0);
    const expectedDueBefore = total - paidBefore;

    const payment = await prisma.payment.create({ data: { orderId: order.id, amount: 300, method: "BKASH", verified: false } });
    const dueAfterCreate = await prisma.$transaction((tx) => recomputeOrderDueAmount(tx, order.id));
    expect(dueAfterCreate).toBe(expectedDueBefore - 300);

    await prisma.payment.delete({ where: { id: payment.id } });
    const dueAfterDelete = await prisma.$transaction((tx) => recomputeOrderDueAmount(tx, order.id));
    expect(dueAfterDelete).toBe(expectedDueBefore);
  });
});
