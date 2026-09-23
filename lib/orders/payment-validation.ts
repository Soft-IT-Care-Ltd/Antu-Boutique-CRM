import { z } from "zod";

import { PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";

// CLAUDE.md rule 1: neither schema below defines a `dueAmount` (or `due_amount`)
// field. Zod's default (non-strict) `.parse()` drops any key that isn't in
// the shape, so a client that sends one gets it silently stripped before
// this data ever reaches a route handler — due_amount is only ever produced
// by lib/orders/totals.ts's recomputeOrderDueAmount, never accepted as input.
// See lib/orders/__tests__/payments-due-amount.integration.test.ts.

export const createPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(PAYMENT_METHOD_VALUES),
  // Omitted → the first active wallet matching the method (lib/wallets/service.ts).
  walletId: z.string().trim().min(1).max(50).optional(),
  transactionId: z.string().trim().max(100).optional(),
  paidAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});

// verified is deliberately absent — verification is its own sensitive
// action gated on payment.verify, not bundled into a general-purpose edit
// gated on payment.edit (see app/api/orders/[id]/payments/[paymentId]/verify/route.ts).
export const updatePaymentSchema = z.object({
  amount: z.coerce.number().positive().optional(),
  method: z.enum(PAYMENT_METHOD_VALUES).optional(),
  walletId: z.string().trim().min(1).max(50).optional(),
  transactionId: z.string().trim().max(100).nullish(),
  paidAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).nullish(),
});

// P2.3 — a refund: a positive amount here, stored negative. Reason required;
// it waits for a second person's approval (lib/payments/refunds.ts).
export const createRefundSchema = z.object({
  amount: z.coerce.number().positive("Enter an amount greater than zero").max(100_000_000),
  method: z.enum(PAYMENT_METHOD_VALUES),
  walletId: z.string().trim().min(1).max(50).optional(),
  transactionId: z.string().trim().max(100).optional(),
  paidAt: z.coerce.date().optional(),
  reason: z.string().trim().min(3, "Give the reason for the refund").max(500),
});

export const refundDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).optional(),
  transactionId: z.string().trim().max(100).optional(),
});
