import { z } from "zod";

import { transactionIdSchema } from "@/lib/orders/payment-validation";
import { POS_PAYMENT_METHODS } from "@/lib/pos/constants";
import { COURIER_CHARGE_BEARER_VALUES, RETURN_CASE_TYPE_VALUES, RETURN_REASON_VALUES } from "@/lib/returns/constants";

// Zod shapes for the PRD §4.11 routes (CLAUDE.md rule 9). Client-safe.

const id = z.string().cuid();
const units = z.coerce.number().int("Whole units only").min(0).max(10_000);
const reasonNote = z.string().trim().max(500).nullish();

export const caseRequestSchema = z
  .object({
    orderId: id,
    type: z.enum(RETURN_CASE_TYPE_VALUES),
    reason: z.enum(RETURN_REASON_VALUES, { error: "Pick a reason" }),
    reasonNote,
    courierChargeBearer: z.enum(COURIER_CHARGE_BEARER_VALUES).nullish(),
    lines: z
      .array(z.object({ orderItemId: id, qty: units.min(1, "Enter how many are coming back"), replacementVariantId: id.nullish() }))
      .min(1, "Pick at least one item")
      .max(50),
  })
  .refine((d) => d.reason !== "OTHER" || Boolean(d.reasonNote?.trim()), { message: "Say what the reason is", path: ["reasonNote"] })
  .refine((d) => d.type !== "EXCHANGE" || Boolean(d.courierChargeBearer), { message: "Say who pays the courier for the replacement", path: ["courierChargeBearer"] })
  .refine((d) => d.type !== "EXCHANGE" || d.lines.every((l) => l.replacementVariantId), { message: "Pick what the customer gets instead for every item", path: ["lines"] });

export const caseDecisionSchema = z
  .object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(500).nullish() })
  .refine((d) => d.decision === "APPROVE" || Boolean(d.note?.trim()), { message: "Give a reason for rejecting it", path: ["note"] });

export const caseCancelSchema = z.object({ note: z.string().trim().min(3, "Say why it's being cancelled").max(500) });

const tenderAmount = z.coerce.number({ error: "Enter an amount" }).positive("Enter an amount greater than zero").max(100_000_000);

export const counterExchangeSchema = z
  .object({
    orderId: id,
    reason: z.enum(RETURN_REASON_VALUES, { error: "Pick a reason" }),
    reasonNote,
    lines: z
      .array(z.object({ orderItemId: id, qty: units.min(1), replacementVariantId: id, goodQty: units, damagedQty: units }))
      .min(1, "Pick at least one item")
      .max(50)
      .refine((lines) => lines.every((l) => l.goodQty + l.damagedQty === l.qty), "Mark every returned unit as Good or Damaged"),
    tenders: z
      .array(
        z.object({
          method: z.enum(POS_PAYMENT_METHODS),
          amount: tenderAmount,
          tendered: tenderAmount.nullish(),
          walletId: z.string().trim().max(50).nullish(),
          transactionId: transactionIdSchema.nullish(),
        }),
      )
      .max(4)
      .default([]),
    refundMethod: z.enum(POS_PAYMENT_METHODS).nullish(),
  })
  .refine((d) => d.reason !== "OTHER" || Boolean(d.reasonNote?.trim()), { message: "Say what the reason is", path: ["reasonNote"] });

export const caseListSchema = z.object({
  tab: z.enum(["requested", "approved", "done", "closed"]).default("requested"),
  type: z.enum(RETURN_CASE_TYPE_VALUES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
