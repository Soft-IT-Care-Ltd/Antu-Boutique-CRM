import { z } from "zod";

import { ORDER_CHANNEL_VALUES } from "@/lib/orders/constants";
import { transactionIdSchema } from "@/lib/orders/payment-validation";
import { POS_TENDER_METHODS } from "@/lib/pos/constants";
import { RETURN_SETTLEMENT_VALUES } from "@/lib/store-credit/constants";
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
    settlement: z.enum(RETURN_SETTLEMENT_VALUES).default("REFUND"),
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
          method: z.enum(POS_TENDER_METHODS),
          amount: tenderAmount,
          tendered: tenderAmount.nullish(),
          walletId: z.string().trim().max(50).nullish(),
          transactionId: transactionIdSchema.nullish(),
        }),
      )
      .max(4)
      .default([]),
    // An anonymous sale's customer — needed for store credit (lib/returns/cases.ts).
    customer: z.object({ phone: z.string().trim().max(20), name: z.string().trim().max(150).nullish() }).nullish(),
  })
  .refine((d) => d.reason !== "OTHER" || Boolean(d.reasonNote?.trim()), { message: "Say what the reason is", path: ["reasonNote"] });

export const caseListSchema = z.object({
  tab: z.enum(["requested", "approved", "done", "closed"]).default("requested"),
  type: z.enum(RETURN_CASE_TYPE_VALUES).optional(),
  /** The original sale's channel (P3.1: every order-based list filters Online / Walk-in). */
  channel: z.enum(ORDER_CHANNEL_VALUES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const counterQuoteSchema = z.object({
  orderId: id,
  lines: z.array(z.object({ orderItemId: id, qty: units.min(1), replacementVariantId: id })).min(1).max(50),
});
