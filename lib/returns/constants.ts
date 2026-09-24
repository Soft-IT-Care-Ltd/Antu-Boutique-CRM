// PRD §4.11 — returns and exchanges. Client-safe: shared by the screens,
// the Zod schemas and the services.

import type { OrderStatusValue } from "@/lib/orders/constants";

export const RETURN_REASON_VALUES = ["WRONG_SIZE", "WRONG_COLOR", "NOT_AS_EXPECTED", "DEFECTIVE", "OTHER"] as const;
export type ReturnReasonValue = (typeof RETURN_REASON_VALUES)[number];

export const RETURN_REASON_LABELS: Record<ReturnReasonValue, string> = {
  WRONG_SIZE: "Wrong size",
  WRONG_COLOR: "Wrong colour",
  NOT_AS_EXPECTED: "Not as expected",
  DEFECTIVE: "Defective",
  OTHER: "Other",
};

export const RETURN_CASE_TYPE_VALUES = ["RETURN", "EXCHANGE"] as const;
export type ReturnCaseTypeValue = (typeof RETURN_CASE_TYPE_VALUES)[number];
export const RETURN_CASE_TYPE_LABELS: Record<ReturnCaseTypeValue, string> = { RETURN: "Return", EXCHANGE: "Exchange" };

export const RETURN_CASE_MODE_VALUES = ["ONLINE", "COUNTER"] as const;
export type ReturnCaseModeValue = (typeof RETURN_CASE_MODE_VALUES)[number];
export const RETURN_CASE_MODE_LABELS: Record<ReturnCaseModeValue, string> = { ONLINE: "By courier", COUNTER: "At the counter" };

export const RETURN_CASE_STATUS_VALUES = ["REQUESTED", "APPROVED", "COMPLETED", "REJECTED", "CANCELLED"] as const;
export type ReturnCaseStatusValue = (typeof RETURN_CASE_STATUS_VALUES)[number];
export const RETURN_CASE_STATUS_LABELS: Record<ReturnCaseStatusValue, string> = {
  REQUESTED: "Awaiting approval",
  APPROVED: "Waiting for the item",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

export const COURIER_CHARGE_BEARER_VALUES = ["CUSTOMER", "COMPANY"] as const;
export type CourierChargeBearerValue = (typeof COURIER_CHARGE_BEARER_VALUES)[number];
export const COURIER_CHARGE_BEARER_LABELS: Record<CourierChargeBearerValue, string> = {
  CUSTOMER: "Customer pays delivery",
  COMPANY: "We pay delivery",
};

/**
 * An order's items can be returned or exchanged once the customer has them:
 * delivered (fully or partly), completed, or already part-way through
 * another exchange. A walk-in sale is COMPLETED at the counter.
 */
export const RETURNABLE_ORDER_STATUSES: OrderStatusValue[] = ["DELIVERED", "PARTIAL_DELIVERED", "COMPLETED", "EXCHANGE_REQUESTED"];

/** The system expense category a company-borne exchange courier charge posts to (migration 20260926090100). */
export const EXCHANGE_COURIER_EXPENSE_CATEGORY_ID = "expcat_exchange_courier";
